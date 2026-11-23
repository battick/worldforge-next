export type TaskStatus = 'running' | 'waiting' | 'interrupted' | 'failed' | 'completed';
export interface DemoDocument { markdown: string; version: number; updatedAt: string }
export interface DemoMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  createdAt: string;
}
export interface DemoTask {
  id: string;
  prompt: string;
  status: TaskStatus;
  step: string;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}
export interface Snapshot {
  eventId: number;
  document: DemoDocument;
  messages: DemoMessage[];
  tasks: DemoTask[];
}
export interface ApiErrorBody {
  error: { code: string; message: string; requestId: string; details?: unknown };
}

/** Provider-neutral contract. Credentials remain in the server process. */
export interface ModelRequest {
  messages: { role: 'system' | 'user' | 'assistant' | 'tool'; content: string; toolCallId?: string }[];
  tools?: { name: string; description: string; parameters: Record<string, unknown> }[];
}
export type ModelEvent =
  | { type: 'text'; text: string }
  | { type: 'tool'; index: number; id?: string; name?: string; arguments: string }
  | { type: 'done'; reason: string };
export interface ModelAdapter {
  stream(request: ModelRequest, signal?: AbortSignal): AsyncIterable<ModelEvent>;
}
