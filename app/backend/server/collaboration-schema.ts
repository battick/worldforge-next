import { z } from 'zod';
import { agentActionSchema, policyInput, targetSchema } from '../core/authorization.ts';
import { commandSchema } from '../core/model.ts';
export { agentActionSchema };
const policy = policyInput.extend({ configured: z.boolean(), version: z.number().int().nonnegative() });
const requirement = z.object({ key: z.string(), operation: z.enum(['read', 'create', 'modify', 'delete', 'save', 'apply']), target: targetSchema.optional(), reason: z.string().optional(), protection: z.string().optional() });
export const collaborationSchema = z.object({
  eventId: z.number().int(), defaults: policy,
  sessions: z.array(z.object({ id: z.string().uuid(), name: z.string(), policy })),
  protections: z.array(z.object({ key: z.string(), target: targetSchema, enabled: z.boolean(), version: z.number().int() })),
  tasks: z.array(z.object({ id: z.string().uuid(), sessionId: z.string().uuid(), title: z.string(), intent: z.enum(['read', 'change']), reads: z.array(targetSchema), command: commandSchema.optional(), status: z.enum(['queued', 'running', 'waiting', 'blocked', 'paused', 'interrupted', 'conflict', 'failed', 'completed', 'cancelled']), step: z.string(), version: z.number().int(), policy: policy.optional(), grants: z.array(z.string()), needed: z.array(requirement), createdAt: z.string(), updatedAt: z.string(), receipt: z.object({ operationId: z.string().uuid(), revision: z.number().int() }).optional(), result: z.array(z.object({ target: targetSchema, value: z.unknown() })).optional(), error: z.string().optional(), retryable: z.boolean().optional().describe('失败是否允许继续原任务；false需重新准备，旧失败省略时可继续后重新核验。') })),
});
