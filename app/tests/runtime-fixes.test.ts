import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fork, spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { Store } from '../backend/server/store.ts';
import { workerUrl } from './helpers/worker-url.ts';

const appDir = fileURLToPath(new URL('..', import.meta.url));
const alive = (child: ChildProcess) => child.exitCode === null && child.signalCode === null;
async function kill(child: ChildProcess) { if (alive(child)) { const closed = once(child, 'close'); child.kill('SIGKILL'); await closed; } }

test('simultaneous crash recovery admits exactly one real process and never removes the winner marker', { timeout: 20_000 }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'worldforge-lock-race-')), children: ChildProcess[] = [];
  const launch = async () => {
    const child = fork(fileURLToPath(new URL('./helpers/lock-worker.ts', import.meta.url)), [dir], { cwd: appDir, execArgv: ['--import', 'tsx'], windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    children.push(child); assert.equal((await once(child, 'message'))[0].type, 'ready'); return child;
  };
  try {
    let owner = await launch(); const opened = once(owner, 'message'); owner.send('open'); assert.equal((await opened)[0].type, 'opened');
    for (let i = 0; i < 3; i++) {
      await kill(owner); // Leaves the actual crashed owner's PID behind.
      const contenders = await Promise.all([launch(), launch()]);
      const results = contenders.map(c => once(c, 'message')); contenders.forEach(c => c.send('open'));
      const types = (await Promise.all(results)).map(result => result[0].type);
      assert.deepEqual([...types].sort(), ['opened', 'rejected']); owner = contenders[types.indexOf('opened')]!;
      assert.equal(await readFile(path.join(dir, 'app.lock'), 'utf8'), String(owner.pid));
      assert.throws(() => new Store(dir)); assert(alive(owner));
    }
    const closed = once(owner, 'close'); owner.send('close'); await closed;
    const reopened = new Store(dir); reopened.close();
  } finally { await Promise.all(children.map(kill)); await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); }
});

test('IPC API exits on an occupied port and releases its data lock', { timeout: 15_000 }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'worldforge-port-failure-')), occupied = createServer();
  await new Promise<void>(resolve => occupied.listen(0, '127.0.0.1', resolve));
  const address = occupied.address(); assert(address && typeof address !== 'string');
  const child = fork(path.join(appDir, 'backend/server/index.ts'), [], { cwd: appDir, execArgv: ['--import', 'tsx'], windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env: { ...process.env, WORLDFORGE_API_PORT: String(address.port), WORLDFORGE_DATA_DIR: dir } });
  let stderr = ''; child.stderr!.on('data', chunk => { stderr += chunk; });
  try {
    const [code] = await once(child, 'close'); assert.equal(code, 1); assert.match(stderr, /EADDRINUSE/); assert.equal(child.connected, false);
    const reopened = new Store(dir); reopened.close();
  } finally { await kill(child); await new Promise<void>(resolve => occupied.close(() => resolve())); await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); }
});

test('worker startup timeout terminates and reaps a real silent child before rejecting', async () => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  try { await assert.rejects(workerUrl(child, 100)); assert(!alive(child)); assert.equal(child.stdout.listenerCount('data'), 0); }
  finally { await kill(child); }
});
