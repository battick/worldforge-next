import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApplication } from './http.ts';

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), import.meta.url.endsWith('.ts') ? '../..' : '../../../..');
const dataDir = path.resolve(process.env.WORLDFORGE_DATA_DIR ?? path.join(appDir, '../data'));
const port = Number(process.env.WORLDFORGE_API_PORT ?? process.env.PORT ?? 4318);
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('PORT 必须是有效端口号。');
const app = await createApplication({ dataDir, frontendOrigins: (process.env.WORLDFORGE_FRONTEND_ORIGINS ?? 'http://127.0.0.1:4317,http://localhost:4317').split(',').filter(Boolean), tickMs: Number(process.env.WORLDFORGE_DEMO_TICK_MS ?? 30) });
app.server.on('error', async (error) => {
  console.error(error instanceof Error ? error.message : '服务启动失败');
  await app.close();
  process.exitCode = 1;
});
app.server.listen(port, '127.0.0.1', () => {
  const address = app.server.address();
  console.log(`WorldForge API S1.2: http://127.0.0.1:${typeof address === 'object' ? address?.port : port}`);
  console.log('后端接口已启动。按 Ctrl+C 关闭；未完成任务下次打开后需手动继续。');
});
let closing = false;
const stop = async () => {
  if (closing) return;
  closing = true;
  await app.close();
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
if (process.send) process.on('message', message => {
  if (message && typeof message === 'object' && 'type' in message && message.type === 'shutdown') {
    stop().finally(() => { if (process.connected) process.disconnect(); });
  }
});
