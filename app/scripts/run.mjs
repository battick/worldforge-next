import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mode = process.argv[2] ?? 'start';
if (!['start', 'dev'].includes(mode)) throw new Error('Use run.mjs start or dev.');
const webPort = Number(process.env.WORLDFORGE_WEB_PORT ?? process.env.PORT ?? 4317);
const apiPort = Number(process.env.WORLDFORGE_API_PORT ?? 4318);
if (![webPort, apiPort].every(port => Number.isInteger(port) && port > 0 && port <= 65535) || webPort === apiPort) throw new Error('前端和后端需要两个不同的有效端口。');
const env = { ...process.env, WORLDFORGE_WEB_PORT: String(webPort), WORLDFORGE_API_PORT: String(apiPort), WORLDFORGE_API_URL: `http://127.0.0.1:${apiPort}`, WORLDFORGE_FRONTEND_ORIGINS: process.env.WORLDFORGE_FRONTEND_ORIGINS ?? `http://127.0.0.1:${webPort},http://localhost:${webPort}` };
const children = [];
let stopping = false;
async function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  process.exitCode = code;
  for (const child of children) {
    if (child.exitCode !== null || child.signalCode) continue;
    if (child.connected) child.send({ type: 'shutdown' }); else child.kill('SIGTERM');
  }
  const deadline = Date.now() + 5000;
  while (children.some(child => child.exitCode === null && !child.signalCode) && Date.now() < deadline) await delay(50);
  for (const child of children) if (child.exitCode === null && !child.signalCode) child.kill('SIGKILL');
}
function launch(args, ipc = false) {
  const child = spawn(process.execPath, args, { cwd: root, env, windowsHide: true, stdio: ipc ? ['inherit', 'inherit', 'inherit', 'ipc'] : 'inherit' });
  children.push(child);
  child.on('error', error => { console.error(error.message); void stop(1); });
  child.on('exit', code => { if (!stopping) void stop(code || 1); });
  return child;
}
process.on('SIGINT', () => void stop()); process.on('SIGTERM', () => void stop());
launch(mode === 'dev' ? ['--import', 'tsx', 'backend/server/index.ts'] : ['dist/api/backend/server/index.js'], true);
let ready = false;
for (let attempt = 0; attempt < 100 && !stopping; attempt++) {
  try { ready = (await fetch(`${env.WORLDFORGE_API_URL}/api/health`, { signal: AbortSignal.timeout(500) })).ok; } catch {}
  if (ready) break;
  await delay(100);
}
if (!ready || stopping) { if (!stopping) { console.error('后端未启动，请检查日志。'); await stop(1); } }
else launch(['node_modules/vite/bin/vite.js', ...(mode === 'start' ? ['preview'] : []), '--config', 'frontend/vite.config.ts']);
