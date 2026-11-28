export const API_VERSION = '1.4.1';
export const API = {
  health: '/api/health', snapshot: '/api/snapshot', events: '/api/events', document: '/api/demo/document',
  messages: '/api/demo/messages', workspace: '/api/core/snapshot', commands: '/api/core/commands', example: '/api/core/example',
  openapi: '/api/openapi.json', collaboration: '/api/agent/state', agentActions: '/api/agent/actions', agentEvents: '/api/agent/events',
  resume: (id: string) => `/api/demo/tasks/${encodeURIComponent(id)}/resume`,
} as const;
export interface Health { status: 'ok'; stage: string; model: 'demo'; apiVersion: string }
export interface TaskAccepted { taskId: string }
