import { API } from '../contracts/api.ts';
import type { Health, TaskAccepted } from '../contracts/api.ts';
import type { ApiErrorBody, DemoDocument, Snapshot } from '../contracts/demo.ts';
import type { ExampleResponse, Receipt, WorkspaceCommand, WorkspaceView } from '../contracts/workspace.ts';

export class ApiClientError extends Error {
  constructor(message: string, public status: number, public code: string, public requestId?: string) { super(message); }
}

/** HTTP/SSE client with no UI framework or database dependency. Reuse with another frontend. */
export function createWorldForgeClient(baseUrl = '', fetcher: typeof fetch = globalThis.fetch) {
  const base = baseUrl.replace(/\/$/, '');
  const url = (path: string) => base + path;
  async function request<T>(path: string, method = 'GET', value?: unknown): Promise<T> {
    const response = await fetcher(url(path), { method, headers: value === undefined ? undefined : { 'Content-Type': 'application/json' }, body: value === undefined ? undefined : JSON.stringify(value) });
    const result = await response.json().catch(() => undefined);
    if (!response.ok) {
      const error = (result as ApiErrorBody | undefined)?.error;
      throw new ApiClientError(error?.message ?? `请求失败 (${response.status})`, response.status, error?.code ?? 'HTTP_ERROR', error?.requestId);
    }
    return result as T;
  }
  return {
    health: () => request<Health>(API.health),
    snapshot: () => request<Snapshot>(API.snapshot),
    save: (markdown: string, version: number) => request<DemoDocument>(API.document, 'PUT', { markdown, version }),
    send: (text: string) => request<TaskAccepted>(API.messages, 'POST', { text }),
    resume: (id: string) => request<TaskAccepted>(API.resume(id), 'POST'),
    workspace: () => request<WorkspaceView>(API.workspace),
    execute: (command: WorkspaceCommand) => request<Receipt>(API.commands, 'POST', command),
    example: () => request<ExampleResponse>(API.example, 'POST', {}),
    subscribe(onSnapshot: (snapshot: Snapshot) => void, onConnection: (connected: boolean) => void) {
      const events = new EventSource(url(API.events));
      events.addEventListener('snapshot', event => { onSnapshot(JSON.parse(event.data)); onConnection(true); });
      events.onerror = () => onConnection(false);
      return () => events.close();
    },
  };
}
