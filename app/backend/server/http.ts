import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AppError } from '../core/errors.ts';
import { Store } from './store.ts';
import { DemoTasks } from './tasks.ts';
import { WorkspaceRepository } from './workspace.ts';
import { makeExample } from '../core/example.ts';
import { API_VERSION } from '../../contracts/api.ts';
import { openApiDocument, documentInput as saveSchema, messageInput as messageSchema } from './openapi.ts';

async function body(req: IncomingMessage, limit = 512_000) {
  if (!req.headers['content-type']?.startsWith('application/json')) throw new AppError('CONTENT_TYPE', '请使用 JSON 提交。', 415);
  let size = 0;
  const buffers: Buffer[] = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new AppError('BODY_TOO_LARGE', '提交内容过大。', 413);
    buffers.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(buffers).toString('utf8')); }
  catch { throw new AppError('INVALID_JSON', '提交内容不是有效 JSON。'); }
}

function json(res: ServerResponse, status: number, value: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
}

export async function createApplication(options: { dataDir: string; tickMs?: number; frontendOrigins?: string[] }) {
  const store = new Store(options.dataDir);
  const tasks = new DemoTasks(store, options.tickMs);
  const workspace = new WorkspaceRepository(store.db);
  const streams = new Set<ServerResponse>();
  let closing = false;
  const allowedOrigins = new Set(options.frontendOrigins ?? []);
  const server = createServer(async (req, res) => {
    const requestId = randomUUID();
    res.setHeader('X-Request-Id', requestId);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'`);
    try {
      if (closing) throw new AppError('SERVER_CLOSING', '服务正在关闭，请稍后重新打开。', 503);
      const host = req.headers.host ?? '';
      if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)) throw new AppError('INVALID_HOST', '只允许从本机访问。', 403);
      if (!req.url?.startsWith('/') || req.url.startsWith('//')) throw new AppError('INVALID_URL', '请求路径不正确。');
      const url = new URL(req.url, `http://${host}`);
      const origin = req.headers.origin;
      const explicitlyAllowed = Boolean(origin && allowedOrigins.has(origin));
      if (origin && origin !== url.origin && !explicitlyAllowed) throw new AppError('INVALID_ORIGIN', '前端地址未获允许。', 403);
      if (req.headers['sec-fetch-site'] === 'cross-site' && !explicitlyAllowed) throw new AppError('INVALID_ORIGIN', '不接受其他网站发起的请求。', 403);
      if (explicitlyAllowed) {
        res.setHeader('Access-Control-Allow-Origin', origin!);
        res.setHeader('Vary', 'Origin');
        res.setHeader('Access-Control-Expose-Headers', 'X-Request-Id');
      }
      if (req.method === 'OPTIONS') {
        if (!origin || (!explicitlyAllowed && origin !== url.origin)) throw new AppError('INVALID_ORIGIN', '前端地址未获允许。', 403);
        res.writeHead(204, { 'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '600' });
        res.end(); return;
      }
      if (url.pathname === '/api/openapi.json' && req.method === 'GET') { json(res, 200, openApiDocument); return; }
      if (url.pathname === '/api/health' && req.method === 'GET') { json(res, 200, { status: 'ok', stage: 'S1.2', model: 'demo', apiVersion: API_VERSION }); return; }
      if (url.pathname === '/api/core/snapshot' && req.method === 'GET') {
        json(res, 200, store.db.transaction(() => ({ state: workspace.read(), history: workspace.history(), references: workspace.references() }))()); return;
      }
      if (url.pathname === '/api/core/commands' && req.method === 'POST') {
        json(res, 200, workspace.execute(await body(req, 2_000_000))); return;
      }
      if (url.pathname === '/api/core/example' && req.method === 'POST') {
        const example = makeExample(workspace.read().revision);
        json(res, 201, { ...example, receipt: workspace.execute(example.command) }); return;
      }
      if (url.pathname === '/api/snapshot' && req.method === 'GET') { json(res, 200, store.snapshot()); return; }
      if (url.pathname === '/api/events' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
        const send = () => {
          if (res.writableEnded || res.destroyed) return;
          const snapshot = store.snapshot();
          res.write(`id: ${snapshot.eventId}\nevent: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`);
        };
        streams.add(res);
        store.events.on('change', send);
        send(); // Reconnect reconciles all state, even when intermediate events were missed.
        const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 15_000);
        res.on('close', () => { clearInterval(heartbeat); store.events.off('change', send); streams.delete(res); });
        return;
      }
      if (url.pathname === '/api/demo/document' && req.method === 'PUT') {
        const input = saveSchema.parse(await body(req));
        json(res, 200, store.saveDocument(input.markdown, input.version)); return;
      }
      if (url.pathname === '/api/demo/messages' && req.method === 'POST') {
        const input = messageSchema.parse(await body(req));
        json(res, 202, { taskId: tasks.start(input.text) }); return;
      }
      const resume = url.pathname.match(/^\/api\/demo\/tasks\/([\w-]+)\/resume$/);
      if (resume?.[1] && req.method === 'POST') {
        tasks.resume(resume[1]); json(res, 202, { taskId: resume[1] }); return;
      }
      throw new AppError('NOT_FOUND', '此服务只提供 /api 接口。', 404);
    } catch (error) {
      const issue = error instanceof z.ZodError
        ? new AppError('VALIDATION_ERROR', '提交内容不符合要求。', 400, error.issues.map(({ path, message }) => ({ path, message })))
        : error instanceof AppError ? error : new AppError('INTERNAL_ERROR', '本机服务执行失败，请重试并查看任务状态。', 500);
      if (!res.headersSent) json(res, issue.status, { error: { code: issue.code, message: issue.message, requestId, ...(issue.details ? { details: issue.details } : {}) } });
      else res.end();
    }
  });
  return {
    server, store, workspace,
    async close() {
      if (closing) return;
      closing = true;
      for (const stream of streams) stream.end();
      await tasks.stop();
      server.closeAllConnections();
      if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      store.close();
    },
  };
}
