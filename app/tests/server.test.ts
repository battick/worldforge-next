import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { createApplication } from '../backend/server/http.ts';
import type { Snapshot } from '../contracts/demo.ts';

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
async function waitFor<T>(read: () => Promise<T>, predicate: (value: T) => boolean) {
  const start = Date.now();
  while (Date.now() - start < 15_000) {
    const result = await read();
    if (predicate(result)) return result;
    await delay(25);
  }
  throw new Error('等待状态超时');
}
async function start(dataDir: string) {
  const app = await createApplication({ dataDir, tickMs: 0 });
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const address = app.server.address();
  assert(address && typeof address !== 'string');
  return { app, url: `http://127.0.0.1:${address.port}` };
}
const post = (url: string, data?: unknown) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: data ? JSON.stringify(data) : undefined });
const snapshot = (url: string) => fetch(`${url}/api/snapshot`).then(r => r.json()) as Promise<Snapshot>;

test('SQLite checkpoints survive service restart; resume and duplicate clicks retain a single task and reply', async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'worldforge-restart-'));
  let current = await start(dataDir);
  try {
    const put = (markdown: string, version: number) => fetch(`${current.url}/api/demo/document`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ markdown, version }) });
    assert.equal((await put('# 重启演练\n\n[[entry-1|灯塔]]', 1)).status, 200);
    assert.equal((await put('过期正文', 1)).status, 409);
    const created = await post(`${current.url}/api/demo/messages`, { text: '灯塔记住每一位过客' });
    assert.equal(created.status, 202);
    const { taskId } = await created.json();
    const before = await waitFor(() => snapshot(current.url), s => s.tasks[0]?.status === 'waiting');
    assert(before.messages[1]?.text.includes('第一步已完成'));
    assert((current.app.store.db.prepare('SELECT count(*) AS n FROM checkpoints').get() as { n: number }).n > 0);
    await current.app.close();
    current = await start(dataDir);
    await delay(100);
    const reopened = await snapshot(current.url);
    assert.equal(reopened.tasks[0]?.id, taskId);
    assert.equal(reopened.tasks[0]?.status, 'waiting');
    assert.equal(reopened.document.markdown, '# 重启演练\n\n[[entry-1|灯塔]]');
    assert.deepEqual(reopened.messages, before.messages);
    assert.equal((await post(`${current.url}/api/demo/tasks/${taskId}/resume`)).status, 202);
    const completed = await waitFor(() => snapshot(current.url), s => s.tasks[0]?.status === 'completed');
    assert.equal(completed.messages.length, 2);
    assert.equal(completed.tasks.length, 1);
    assert.equal(completed.messages[1]?.text.match(/任务已从保存的位置继续并完成/g)?.length, 1);
    const count = (current.app.store.db.prepare('SELECT count(*) AS n FROM checkpoints').get() as { n: number }).n;
    assert.equal((await post(`${current.url}/api/demo/tasks/${taskId}/resume`)).status, 202);
    assert.equal((current.app.store.db.prepare('SELECT count(*) AS n FROM checkpoints').get() as { n: number }).n, count);
    assert.deepEqual((await snapshot(current.url)).messages, completed.messages);
  } finally { await current.app.close(); await rm(dataDir, { recursive: true, force: true }); }
});

test('API validates input, rejects cross-site requests and isolates errors', async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'worldforge-http-'));
  const { app, url } = await start(dataDir);
  try {
    const response = await post(`${url}/api/demo/messages`, { text: '', apiKey: 'must-not-appear' });
    assert.equal(response.status, 400);
    const error = await response.json();
    assert.equal(error.error.code, 'VALIDATION_ERROR');
    assert.equal(typeof error.error.requestId, 'string');
    assert(!JSON.stringify(error).includes('must-not-appear'));
    assert.equal((await fetch(`${url}/api/snapshot`, { headers: { Origin: 'https://untrusted.example' } })).status, 403);
    assert.equal((await post(`${url}/api/demo/tasks/missing/resume`)).status, 404);
    const stream = await fetch(`${url}/api/events`);
    assert.equal(stream.headers.get('content-type'), 'text/event-stream; charset=utf-8');
    const reader = stream.body!.getReader();
    const frame = new TextDecoder().decode((await reader.read()).value);
    assert(frame.includes('event: snapshot'));
    assert(frame.includes('id: 0'));
    await reader.cancel();
  } finally { await app.close(); await rm(dataDir, { recursive: true, force: true }); }
});

async function launchWorker(dataDir: string) {
  const child = spawn(process.execPath, ['--import', 'tsx', 'backend/server/index.ts'], {
    cwd: appDir, env: { ...process.env, PORT: '0', WORLDFORGE_API_PORT: '0', WORLDFORGE_DATA_DIR: dataDir, WORLDFORGE_DEMO_TICK_MS: '45' }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const url = await new Promise<string>((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error('子进程未启动')), 15_000);
    child.stdout.on('data', chunk => {
      output += chunk.toString();
      const match = output.match(/http:\/\/127\.0\.0\.1:\d+/);
      if (match) { clearTimeout(timer); resolve(match[0]); }
    });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`子进程退出 ${code}`)); });
    child.once('error', reject);
  });
  return { child, url };
}

test('abrupt process kill mid-stream restores progress without auto-running or duplicating messages', async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'worldforge-crash-'));
  let worker = await launchWorker(dataDir);
  try {
    const { taskId } = await (await post(`${worker.url}/api/demo/messages`, { text: '意外关机恢复演练' })).json();
    await waitFor(() => snapshot(worker.url), s => s.tasks[0]?.status === 'running' && (s.messages[1]?.text.length ?? 0) > 5);
    await new Promise<void>(resolve => { worker.child.once('exit', () => resolve()); worker.child.kill('SIGKILL'); });
    worker = await launchWorker(dataDir);
    const reopened = await snapshot(worker.url);
    assert.equal(reopened.tasks[0]?.id, taskId);
    assert.equal(reopened.tasks[0]?.status, 'interrupted');
    await delay(200);
    assert.deepEqual((await snapshot(worker.url)).messages, reopened.messages);
    await post(`${worker.url}/api/demo/tasks/${taskId}/resume`);
    const continued = await waitFor(() => snapshot(worker.url), s => ['waiting', 'completed'].includes(s.tasks[0]?.status ?? ''));
    if (continued.tasks[0]?.status === 'waiting') await post(`${worker.url}/api/demo/tasks/${taskId}/resume`);
    const done = await waitFor(() => snapshot(worker.url), s => s.tasks[0]?.status === 'completed');
    assert.equal(done.messages.length, 2);
    assert.equal(done.messages[1]?.text.match(/已收到/g)?.length, 1);
    assert.equal(done.messages[1]?.text.match(/任务已从保存的位置继续并完成/g)?.length, 1);
  } finally {
    if (worker.child.exitCode === null && worker.child.signalCode === null) await new Promise<void>(resolve => { worker.child.once('exit', () => resolve()); worker.child.kill('SIGKILL'); });
    await rm(dataDir, { recursive: true, force: true });
  }
});
