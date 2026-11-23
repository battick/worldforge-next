import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { OpenAiCompatibleAdapter } from '../backend/server/model-adapter.ts';
import type { ModelEvent } from '../contracts/demo.ts';
import { AppError } from '../backend/core/errors.ts';

test('OpenAI-compatible adapter sends messages/tools and decodes fragmented UTF-8 SSE/tool deltas', async () => {
  let captured: any;
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    captured = { url: req.url, auth: req.headers.authorization, body: JSON.parse(body) };
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const frames = [
      { choices: [{ delta: { content: '你好，雾海 🌊' } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'tool-1', function: { name: 'lookup', arguments: '{"id":' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"entry-1"}' } }] }, finish_reason: 'tool_calls' }] },
    ];
    const bytes = Buffer.from(frames.map(frame => `data: ${JSON.stringify(frame)}\r\n\r\n`).join('') + 'data: [DONE]\r\n\r\n');
    for (let i = 0; i < bytes.length; i += 7) {
      res.write(bytes.subarray(i, i + 7));
      await new Promise(resolve => setImmediate(resolve));
    }
    res.end();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address(); assert(address && typeof address !== 'string');
    const adapter = new OpenAiCompatibleAdapter({ baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: 'fixture-only', model: 'fixture' });
    const events: ModelEvent[] = [];
    for await (const event of adapter.stream({ messages: [{ role: 'user', content: '找灯塔' }], tools: [{ name: 'lookup', description: '读取条目', parameters: { type: 'object' } }] })) events.push(event);
    assert.equal(captured.url, '/v1/chat/completions');
    assert.equal(captured.auth, 'Bearer fixture-only');
    assert.equal(captured.body.stream, true);
    assert.equal(captured.body.tools[0].function.name, 'lookup');
    assert.deepEqual(events, [
      { type: 'text', text: '你好，雾海 🌊' },
      { type: 'tool', index: 0, id: 'tool-1', name: 'lookup', arguments: '{"id":' },
      { type: 'tool', index: 0, id: undefined, name: undefined, arguments: '"entry-1"}' },
      { type: 'done', reason: 'tool_calls' },
    ]);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('adapter reports provider failures without exposing raw response or credentials', async () => {
  const server = createServer((_req, res) => { res.writeHead(401); res.end('SECRET_FIXTURE_DO_NOT_EXPOSE'); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address(); assert(address && typeof address !== 'string');
    const adapter = new OpenAiCompatibleAdapter({ baseUrl: `http://127.0.0.1:${address.port}`, apiKey: 'SECRET_FIXTURE', model: 'fixture' });
    await assert.rejects(async () => { for await (const _event of adapter.stream({ messages: [] })) {} }, error => {
      assert(error instanceof Error); assert(error.message.includes('401')); assert(!error.message.includes('SECRET')); return true;
    });
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('truncated streams fail instead of claiming completion', async () => {
  const server = createServer((_req, res) => { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.end('data: {"choices":[{"delta":{"content":"部分回复"}}]}\n\n'); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address(); assert(address && typeof address !== 'string');
    const adapter = new OpenAiCompatibleAdapter({ baseUrl: `http://127.0.0.1:${address.port}`, apiKey: 'fixture', model: 'fixture' });
    await assert.rejects(async () => { for await (const _event of adapter.stream({ messages: [] })) {} }, /提前中断/);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('cancelling an active message stream reports MODEL_ABORTED', async () => {
  const server = createServer((_req, res) => { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write('data: {"choices":[{"delta":{"content":"开始"}}]}\n\n'); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address(); assert(address && typeof address !== 'string');
    const controller = new AbortController();
    const adapter = new OpenAiCompatibleAdapter({ baseUrl: `http://127.0.0.1:${address.port}`, apiKey: 'fixture', model: 'fixture' });
    const stream = adapter.stream({ messages: [] }, controller.signal)[Symbol.asyncIterator]();
    assert.equal((await stream.next()).value?.type, 'text'); controller.abort();
    await assert.rejects(() => stream.next(), error => error instanceof AppError && error.code === 'MODEL_ABORTED');
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
