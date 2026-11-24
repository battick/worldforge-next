export const API_VERSION = '1.2.0';
export const API = {
  health: '/api/health', snapshot: '/api/snapshot', events: '/api/events', document: '/api/demo/document',
  messages: '/api/demo/messages', workspace: '/api/core/snapshot', commands: '/api/core/commands', example: '/api/core/example',
  openapi: '/api/openapi.json',
  resume: (id: string) => `/api/demo/tasks/${encodeURIComponent(id)}/resume`,
} as const;
export interface Health { status: 'ok'; stage: string; model: 'demo'; apiVersion: string }
export interface TaskAccepted { taskId: string }
