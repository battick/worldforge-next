import { AppError } from '../core/errors.ts';
import type { ModelAdapter, ModelEvent, ModelRequest } from '../../contracts/demo.ts';

export interface OpenAiCompatibleConfig { baseUrl: string; apiKey: string; model: string }

/** First protocol: OpenAI-compatible /chat/completions. Not connected to the demo. */
export class OpenAiCompatibleAdapter implements ModelAdapter {
  constructor(private config: OpenAiCompatibleConfig) {}

  async *stream(request: ModelRequest, signal?: AbortSignal): AsyncIterable<ModelEvent> {
    let url: URL;
    try { url = new URL(`${this.config.baseUrl.replace(/\/$/, '')}/chat/completions`); }
    catch { throw new AppError('MODEL_CONFIG', '模型地址格式无效。'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
      throw new AppError('MODEL_CONFIG', '模型地址必须是有效的 HTTP 或 HTTPS 服务地址。');
    }
    const timeout = AbortSignal.timeout(60_000);
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.config.apiKey}` },
        body: JSON.stringify({
          model: this.config.model, stream: true,
          messages: request.messages.map(({ toolCallId, ...message }) => ({ ...message, ...(toolCallId ? { tool_call_id: toolCallId } : {}) })),
          ...(request.tools?.length ? { tools: request.tools.map(tool => ({ type: 'function', function: tool })) } : {}),
        }),
      });
    } catch {
      throw new AppError(signal?.aborted ? 'MODEL_ABORTED' : 'MODEL_NETWORK', signal?.aborted ? '模型请求已停止。' : '无法连接模型服务或请求已超时。', 502);
    }
    if (!response.ok) {
      await response.body?.cancel();
      // Provider response bodies may contain credentials or user data; never expose them.
      throw new AppError('MODEL_HTTP', `模型服务返回 HTTP ${response.status}。`, 502);
    }
    if (!response.body || !response.headers.get('content-type')?.includes('text/event-stream')) {
      await response.body?.cancel();
      throw new AppError('MODEL_PROTOCOL', '模型服务未返回预期的流式消息。', 502);
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let finished = false;
    try {
      while (true) {
        const chunk = await reader.read();
        buffer += decoder.decode(chunk.value, { stream: !chunk.done });
        // Normalize only complete CRLF pairs, preserving a CR split across network chunks.
        buffer = buffer.replace(/\r\n/g, '\n');
        let boundary: number;
        while ((boundary = buffer.indexOf('\n\n')) >= 0) {
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const data = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
          if (!data) continue;
          if (data === '[DONE]') { finished = true; return; }
          let payload;
          try { payload = JSON.parse(data); }
          catch { throw new AppError('MODEL_PROTOCOL', '模型服务返回了无效的消息。', 502); }
          if (payload.error) throw new AppError('MODEL_PROVIDER', '模型服务报告执行失败。', 502);
          const choice = payload.choices?.[0];
          if (choice?.delta?.content) yield { type: 'text', text: choice.delta.content };
          for (const tool of choice?.delta?.tool_calls ?? []) {
            yield { type: 'tool', index: tool.index, id: tool.id, name: tool.function?.name, arguments: tool.function?.arguments ?? '' };
          }
          if (choice?.finish_reason) {
            finished = true;
            yield { type: 'done', reason: choice.finish_reason };
          }
        }
        if (buffer.length > 1_000_000) throw new AppError('MODEL_PROTOCOL', '模型服务的单条消息过大。', 502);
        if (chunk.done) break;
      }
      if (!finished) throw new AppError('MODEL_TRUNCATED', '模型连接提前中断，可保留现有进度后重试。', 502);
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError(signal?.aborted ? 'MODEL_ABORTED' : 'MODEL_NETWORK', signal?.aborted ? '模型请求已停止。' : '模型消息流已中断。', 502);
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }
}
