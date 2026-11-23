import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createApplication } from '../backend/server/http.ts';
import { createWorldForgeClient, ApiClientError } from '../client/index.ts';
import { API_VERSION } from '../contracts/api.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
async function start() {
  const dir = await mkdtemp(path.join(tmpdir(), 'worldforge-api-contract-'));
  const app = await createApplication({ dataDir: dir, frontendOrigins: ['http://127.0.0.1:4329'], tickMs: 0 });
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const address = app.server.address(); assert(address && typeof address !== 'string');
  return { app, url: `http://127.0.0.1:${address.port}`, async close() { await app.close(); await rm(dir, { recursive: true, force: true }); } };
}

test('independent API supports a framework-free client without serving a frontend', async () => {
  const running = await start();
  try {
    const client = createWorldForgeClient(running.url);
    assert.equal((await client.health()).apiVersion, API_VERSION);
    assert.equal((await fetch(running.url)).status, 404);
    const before = await client.snapshot();
    const saved = await client.save('# 从独立客户端保存', before.document.version);
    assert.equal(saved.version, before.document.version + 1);
    await assert.rejects(() => client.save('旧版不能覆盖', before.document.version), error => error instanceof ApiClientError && error.status === 409 && error.code === 'VERSION_CONFLICT' && Boolean(error.requestId));
    const sample = await client.example();
    assert.equal((await client.workspace()).state.worlds.length, 2);
    assert.deepEqual(await client.execute(sample.command), sample.receipt);
    assert.equal((await client.workspace()).history.length, 1);
  } finally { await running.close(); }
});

test('explicit frontend origins work with CORS/preflight; other websites remain denied', async () => {
  const running = await start();
  try {
    const origin = 'http://127.0.0.1:4329';
    const response = await fetch(`${running.url}/api/snapshot`, { headers: { Origin: origin, 'Sec-Fetch-Site': 'cross-site' } });
    assert.equal(response.status, 200); assert.equal(response.headers.get('access-control-allow-origin'), origin);
    const preflight = await fetch(`${running.url}/api/demo/document`, { method: 'OPTIONS', headers: { Origin: origin, 'Access-Control-Request-Method': 'PUT', 'Access-Control-Request-Headers': 'content-type' } });
    assert.equal(preflight.status, 204); assert(preflight.headers.get('access-control-allow-methods')?.includes('PUT'));
    const denied = await fetch(`${running.url}/api/snapshot`, { headers: { Origin: 'https://untrusted.example' } });
    assert.equal(denied.status, 403); assert.equal(denied.headers.get('access-control-allow-origin'), null);
  } finally { await running.close(); }
});

test('checked-in OpenAPI equals the live API contract and preserves existing endpoints', async () => {
  const running = await start();
  try {
    const live = await (await fetch(`${running.url}/api/openapi.json`)).json();
    const generated = JSON.parse(await readFile(path.join(root, 'contracts/openapi.json'), 'utf8'));
    assert.deepEqual(live, generated);
    assert.equal(live.info.version, API_VERSION);
    for (const route of ['/api/health', '/api/snapshot', '/api/events', '/api/demo/document', '/api/demo/messages', '/api/demo/tasks/{id}/resume', '/api/core/snapshot', '/api/core/commands', '/api/core/example']) assert(live.paths[route], route);
    assert.equal(live.paths['/api/demo/document'].put.requestBody.content['application/json'].schema.properties.version.type, 'integer');
  } finally { await running.close(); }
});

test('frontend and client depend only on public contracts, with authored styles in CSS files', async () => {
  async function files(directory: string): Promise<string[]> {
    const entries = await readdir(directory, { withFileTypes: true });
    return (await Promise.all(entries.map(entry => entry.isDirectory() ? files(path.join(directory, entry.name)) : [path.join(directory, entry.name)]))).flat();
  }
  for (const file of [...await files(path.join(root, 'frontend/src')), ...await files(path.join(root, 'client'))].filter(file => /\.tsx?$/.test(file))) {
    const source = await readFile(file, 'utf8');
    assert(!/(?:from\s+|import\s*)['"][^'"]*(?:backend\/|node:|better-sqlite3)/.test(source), file);
    assert(!source.includes('style={{'), file);
  }
});
