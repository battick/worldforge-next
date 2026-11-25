import { z } from 'zod';
import { operations, type AgentTask, type Policy, type Protection, type Requirement, type Target } from '../../contracts/collaboration.ts';
import type { Difference, WorkspaceState, ContentObject } from '../../contracts/workspace.ts';
import { canonical, commandSchema } from './model.ts';
export const targetSchema = z.object({ kind: z.enum(['object', 'field', 'resource', 'definition']), id: z.union([z.string().uuid(), z.enum(['sys.id', 'sys.kind', 'sys.created', 'sys.updated', 'sys.version'])]), objectId: z.string().uuid().optional() }).strict().refine(t => !t.objectId || t.kind === 'field', 'objectId仅用于某个条目内的字段。');
export const policyInput = z.object({ configured: z.literal(true), initiative: z.enum(['respond', 'suggest', 'advance']), contribution: z.enum(['organize', 'expand', 'create']), permissions: z.object({ read: z.enum(['allow', 'ask', 'deny']), create: z.enum(['allow', 'ask', 'deny']), modify: z.enum(['allow', 'ask', 'deny']), delete: z.enum(['allow', 'ask', 'deny']), save: z.enum(['allow', 'ask', 'deny']), apply: z.enum(['allow', 'ask', 'deny']) }).strict() }).strict();
const control = (type: 'task.approve' | 'task.pause' | 'task.resume' | 'task.cancel') => z.object({ type: z.literal(type), id: z.string().uuid(), expectedVersion: z.number().int().nonnegative() }).strict().describe(type === 'task.resume' ? '继续暂停、中断或可重试失败的原任务，保留原计划/操作编号/授权；冲突和无效方案不能重试。' : type === 'task.cancel' ? '取消未完成任务，包括失败和冲突；不回滚已提交成果。' : '用户控制指定任务，版本必须匹配。');
export const agentActionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('policy.update'), sessionId: z.string().uuid().optional(), expectedVersion: z.number().int().nonnegative(), policy: policyInput }).strict(),
  z.object({ type: z.literal('session.create'), id: z.string().uuid(), name: z.string().trim().min(1).max(100) }).strict(),
  z.object({ type: z.literal('protection.set'), target: targetSchema, enabled: z.boolean(), expectedVersion: z.number().int().nonnegative() }).strict(),
  z.object({ type: z.literal('task.enqueue'), id: z.string().uuid(), sessionId: z.string().uuid(), title: z.string().trim().min(1).max(200), intent: z.enum(['read', 'change']), reads: z.array(targetSchema).max(1000), command: commandSchema.optional() }).strict(),
  control('task.approve'), control('task.pause'), control('task.resume'), control('task.cancel'),
]);
export function initialPolicy(): Policy { return { configured: false, initiative: 'respond', contribution: 'organize', permissions: Object.fromEntries(operations.map(o => [o, 'ask'])) as Policy['permissions'], version: 0 }; }
export const targetKey = (target: Target) => canonical(target);
const requirement = (operation: Requirement['operation'], target?: Target): Requirement => ({ key: `${operation}:${target ? targetKey(target) : '*'}`, operation, ...(target ? { target } : {}) });
/** Use actual prepared differences, including indirect relation/configuration changes. */
export function requirements(task: AgentTask, changes: Difference[], before: WorkspaceState, after: WorkspaceState): Requirement[] {
  const result = task.reads.map(target => requirement('read', target));
  const affectedDefinitions = new Set<string>();
  for (const diff of changes) {
    if (diff.collection === 'worlds') continue;
    const kind = diff.collection === 'objects' ? 'object' : diff.collection === 'definitions' ? 'definition' : 'resource';
    const operation = diff.before === null ? 'create' : diff.after === null ? 'delete' : 'modify';
    result.push(requirement(operation, { kind, id: diff.id }));
    if (kind === 'definition') affectedDefinitions.add(diff.id);
    if (kind === 'object') {
      const a = diff.before as ContentObject | null, b = diff.after as ContentObject | null;
      for (const fid of new Set([...Object.keys(a?.fields ?? {}), ...Object.keys(b?.fields ?? {})])) if (!fid.startsWith('sys.') && canonical(a?.fields[fid]) !== canonical(b?.fields[fid])) result.push(requirement(operation, { kind: 'field', id: fid, objectId: diff.id }));
    }
  }
  for (const object of [...before.objects, ...after.objects]) for (const fid of Object.keys(object.fields)) if (affectedDefinitions.has(fid)) {
    result.push(requirement('modify', { kind: 'object', id: object.id }), requirement('modify', { kind: 'field', id: fid, objectId: object.id }));
  }
  if (task.command) result.push(requirement('save'), requirement('apply'));
  return [...new Map(result.map(r => [r.key, r])).values()];
}
function matches(p: Target, target: Target) {
  if (p.kind === 'object') return (target.kind === 'object' && p.id === target.id) || (target.kind === 'field' && p.id === target.objectId);
  if (p.kind === 'definition') return p.id === target.id && ['definition', 'field'].includes(target.kind);
  if (p.kind === 'field') return p.id === target.id && ['definition', 'field'].includes(target.kind) && (!p.objectId || p.objectId === target.objectId);
  return target.kind === 'resource' && p.id === target.id;
}
export function missingPermissions(task: AgentTask, all: Requirement[], protections: Protection[]): Requirement[] {
  const result: Requirement[] = [];
  for (const r of all) {
    const decision = task.policy?.configured ? task.policy.permissions[r.operation] : 'ask';
    if (decision !== 'allow' && !task.grants.includes(r.key)) result.push({ ...r, reason: decision === 'deny' ? '原任务权限禁止此操作，需用户明确给予本任务额外授权。' : '此操作需要用户授权。' });
    if (r.operation !== 'read' && r.target) for (const p of protections.filter(p => p.enabled && matches(p.target, r.target!))) {
      const key = `${r.key}:protection:${p.key}:${p.version}`;
      if (!task.grants.includes(key)) result.push({ ...r, key, protection: p.key, reason: '内容受保护，需要本任务的明确授权。' });
    }
  }
  return result;
}
