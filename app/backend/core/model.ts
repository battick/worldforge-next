import { z } from 'zod';
import { AppError } from './errors.ts';
import { objectKinds, roles, marks, type ContentObject, type Definition, type WorkspaceState, type ReferenceIndex, type ObjectKind, type WorkspaceCommand } from '../../contracts/workspace.ts';
export * from '../../contracts/workspace.ts';

const id = z.string().uuid();
const fieldId = z.union([id, z.enum(['sys.id', 'sys.kind', 'sys.created', 'sys.updated', 'sys.version'])]);
const constraintsSchema = z.object({
  required: z.boolean().optional(), minCount: z.number().int().nonnegative().optional(), maxCount: z.number().int().nonnegative().optional(),
  min: z.number().optional(), max: z.number().optional(), minLength: z.number().int().nonnegative().optional(), maxLength: z.number().int().nonnegative().optional(),
  options: z.array(z.string()).optional(), unique: z.enum(['world', 'workspace']).optional(), targetKinds: z.array(z.enum(objectKinds)).optional(), sameWorld: z.boolean().optional(),
}).strict();
export const definitionSchema = z.object({
  id: fieldId, scope: z.union([z.literal('global'), id]), name: z.string().trim().min(1).max(100),
  type: z.enum(['text', 'number', 'boolean', 'choice', 'link', 'reference', 'resource', 'json']),
  marks: z.array(z.enum(marks)), constraints: constraintsSchema, comment: z.string().max(4000).optional(), system: z.enum(roles).optional(),
}).strict();
const fields = z.record(fieldId, z.array(z.unknown()));
export const commandSchema = z.object({
  operationId: id, baseRevision: z.number().int().nonnegative(),
  worldId: id.optional(),
  changes: z.array(z.discriminatedUnion('type', [
    z.object({ type: z.literal('world.create'), id }).strict(),
    z.object({ type: z.literal('definition.put'), definition: definitionSchema.omit({ scope: true }).extend({ scope: z.union([z.literal('global'), id]).optional() }) }).strict(),
    z.object({ type: z.literal('definition.delete'), id: fieldId }).strict(),
    z.object({ type: z.literal('object.create'), id, worldId: id, kind: z.enum(objectKinds), fields }).strict(),
    z.object({ type: z.literal('object.update'), id, set: fields.optional(), unset: z.array(fieldId).optional() }).strict(),
    z.object({ type: z.literal('object.delete'), id }).strict(),
    z.object({ type: z.literal('resource.put'), id, worldId: id, path: z.string().max(500), mime: z.string().min(1).max(100), content: z.string().max(1_400_000) }).strict(),
    z.object({ type: z.literal('resource.delete'), id }).strict(),
  ])).min(1).max(1000),
}).strict() satisfies z.ZodType<WorkspaceCommand>;
export function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  return '{' + Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, v]) => JSON.stringify(key) + ':' + canonical(v)).join(',') + '}';
}
export function kindOf(object: ContentObject): ObjectKind { return object.fields['sys.kind']?.[0] as ObjectKind; }
export function objectVersion(object: ContentObject): number { return object.fields['sys.version']?.[0] as number; }
export function systemDefinitions(): Definition[] {
  return roles.map(role => ({ id: `sys.${role}`, scope: 'global', name: ({ id: '身份', kind: '对象用途', created: '创建时间', updated: '修改时间', version: '数据版本' })[role], type: role === 'version' ? 'number' : 'text', marks: [role === 'id' ? 'identity' : role], constraints: { required: true, minCount: 1, maxCount: 1 }, system: role, version: 1 }));
}
function fail(path: string, message: string): never { throw new AppError('MODEL_INVALID', message, 422, { path }); }
function jsonValue(value: unknown, depth = 0): boolean {
  if (depth > 20) return false;
  if (value === null || ['string', 'boolean'].includes(typeof value)) return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.every(v => jsonValue(v, depth + 1));
  return Object.getPrototypeOf(value) === Object.prototype && Object.values(value).every(v => jsonValue(v, depth + 1));
}

/** Validate the complete candidate, including all worlds using a global definition. */
export function validateState(state: WorkspaceState): ReferenceIndex[] {
  const definitions = new Map(state.definitions.map(d => [d.id, d]));
  const objects = new Map(state.objects.map(o => [o.id, o]));
  const worlds = new Set(state.worlds.map(w => w.id));
  const resources = new Map(state.resources.map(r => [r.id, r]));
  const indexes: ReferenceIndex[] = [];
  const identities = [...state.definitions, ...state.objects, ...state.resources].map(item => item.id);
  if (new Set(identities).size !== identities.length) fail('identities', '字段、内容和资源不能共用同一身份。');
  const unique = new Map<string, Set<string>>();
  for (const d of state.definitions) {
    const p = `definitions.${d.id}`;
    if (d.scope !== 'global' && !worlds.has(d.scope)) fail(p, '世界字段的所属世界不存在。');
    if (new Set(d.marks).size !== d.marks.length) fail(p, '功能标记重复。');
    const c = d.constraints;
    if ((c.min !== undefined || c.max !== undefined) && d.type !== 'number') fail(p, '数字范围只能用于数字字段。');
    if ((c.minLength !== undefined || c.maxLength !== undefined) && !['text', 'choice', 'link'].includes(d.type)) fail(p, '文字长度只能用于文字、链接或选项字段。');
    if (c.options && d.type !== 'choice') fail(p, '选项约束只能用于选项字段。');
    if ((c.targetKinds || c.sameWorld !== undefined) && !['reference', 'resource'].includes(d.type)) fail(p, '引用范围约束不能用于此值类型。');
    if (c.targetKinds && d.type !== 'reference') fail(p, '对象用途约束只能用于对象引用。');
    if ((c.minCount ?? 0) > (c.maxCount ?? Infinity) || (c.min ?? -Infinity) > (c.max ?? Infinity) || (c.minLength ?? 0) > (c.maxLength ?? Infinity)) fail(p, '约束上下限不匹配。');
    if (d.type === 'choice' && (!c.options?.length || new Set(c.options).size !== c.options.length)) fail(p, '选项必须非空且不重复。');
    const compat: Partial<Record<typeof marks[number], string[]>> = { identity: ['text'], kind: ['text'], created: ['text'], updated: ['text'], version: ['number'], title: ['text'], body: ['resource'], source: ['reference'], target: ['reference'], navigation: ['reference'], cover: ['resource'] };
    for (const mark of d.marks) {
      if (compat[mark] && !compat[mark]!.includes(d.type)) fail(p, `功能标记 ${mark} 与字段类型不兼容。`);
      if (['identity', 'kind', 'created', 'updated', 'version'].includes(mark) && !d.system) fail(p, '系统职责标记不能添加到普通字段。');
    }
  }
  for (const w of state.worlds) if (w.rootId !== w.id || !objects.has(w.rootId) || kindOf(objects.get(w.rootId)!) !== 'world') fail(`worlds.${w.id}`, '世界必须有匹配的根对象。');
  for (const r of state.resources) {
    if (!worlds.has(r.worldId)) fail(`resources.${r.id}`, '资源的所属世界不存在。');
    if (!state.resourceVersions.some(v => v.id === r.id && v.version === r.version)) fail(`resources.${r.id}`, '资源内容版本缺失。');
    if (state.resources.some(other => other.id !== r.id && other.worldId === r.worldId && other.path === r.path)) fail(`resources.${r.id}`, '同一世界中的逻辑路径重复。');
  }
  for (const o of state.objects) {
    const p = `objects.${o.id}`;
    if (!worlds.has(o.worldId)) fail(p, '条目的所属世界不存在。');
    for (const role of roles) {
      const values = o.fields[`sys.${role}`];
      if (values?.length !== 1) fail(p, '对象缺少系统维护字段。');
    }
    if (o.fields['sys.id']![0] !== o.id || !objectKinds.includes(kindOf(o)) || (kindOf(o) === 'world' && o.id !== o.worldId)) fail(p, '系统身份或用途不匹配。');
    let source = 0, target = 0;
    const intervalFields = new Set<string>();
    for (const [fid, values] of Object.entries(o.fields)) {
      const fp = `${p}.fields.${fid}`;
      const d = definitions.get(fid);
      if (!d) fail(fp, '字段定义不存在，不能保留无定义的值。');
      if (d.scope !== 'global' && d.scope !== o.worldId) fail(fp, '不能使用其他世界的本地字段。');
      const c = d.constraints;
      for (const mark of ['time-start', 'time-end'] as const) if (d.marks.includes(mark)) {
        if (intervalFields.has(mark) || values.length > 1) fail(fp, '一个对象的时间开始和结束各至多一项。');
        intervalFields.add(mark);
      }
      if (values.length < Math.max(c.minCount ?? 0, c.required ? 1 : 0) || values.length > (c.maxCount ?? Infinity)) fail(fp, '字段值数量不符合约束。');
      for (const [i, value] of values.entries()) {
        const vp = `${fp}.${i}`;
        if (!jsonValue(value)) fail(vp, '值必须是有限深度的有效JSON。');
        if (['text', 'choice', 'link'].includes(d.type) && typeof value !== 'string') fail(vp, '需要文字值。');
        if (d.type === 'link') {
          let url: URL; try { url = new URL(value as string); } catch { fail(vp, '链接地址格式不正确。'); }
          if (!['http:', 'https:', 'mailto:'].includes(url.protocol)) fail(vp, '链接协议不受支持。');
        }
        if (d.type === 'number' && (typeof value !== 'number' || !Number.isFinite(value))) fail(vp, '需要有限数字。');
        if (d.type === 'boolean' && typeof value !== 'boolean') fail(vp, '需要是或否。');
        if (typeof value === 'string' && (value.length < (c.minLength ?? 0) || value.length > (c.maxLength ?? Infinity) || (c.required && value.length === 0))) fail(vp, '文字长度不符合约束。');
        if (typeof value === 'number' && (value < (c.min ?? -Infinity) || value > (c.max ?? Infinity))) fail(vp, '数字超出范围。');
        if (d.type === 'choice' && !c.options?.includes(value as string)) fail(vp, '值不在允许的选项中。');
        if (d.type === 'reference') {
          const ref = value as { ref?: unknown };
          if (!ref || typeof ref.ref !== 'string' || Object.keys(ref).length !== 1 || !objects.has(ref.ref)) fail(vp, '引用对象不存在或格式不正确。');
          const destination = objects.get(ref.ref)!;
          if (c.sameWorld && destination.worldId !== o.worldId) fail(vp, '此字段限制引用同一世界。');
          if (c.targetKinds && !c.targetKinds.includes(kindOf(destination))) fail(vp, '引用对象用途不符合限制。');
          indexes.push({ ownerId: o.id, fieldId: fid, targetId: ref.ref, kind: 'object' });
        }
        if (d.type === 'resource') {
          const ref = value as { resource?: unknown; version?: unknown };
          if (!ref || typeof ref.resource !== 'string' || typeof ref.version !== 'number' || Object.keys(ref).length !== 2 || !resources.has(ref.resource) || !state.resourceVersions.some(v => v.id === ref.resource && v.version === ref.version)) fail(vp, '资源或指定内容版本不存在。');
          if (c.sameWorld && resources.get(ref.resource)!.worldId !== o.worldId) fail(vp, '此字段限制同一世界的资源。');
          indexes.push({ ownerId: o.id, fieldId: fid, targetId: ref.resource, kind: 'resource' });
        }
        if (c.unique) {
          const key = `${fid}:${c.unique === 'world' ? o.worldId : '*'}`;
          const seen = unique.get(key) ?? new Set<string>();
          const encoded = canonical(value);
          if (seen.has(encoded)) fail(vp, '字段值违反唯一性约束。');
          seen.add(encoded); unique.set(key, seen);
        }
      }
      if (d.marks.includes('source')) source += values.length;
      if (d.marks.includes('target')) target += values.length;
    }
    if (kindOf(o) === 'relation' && (!source || !target)) fail(p, '关系必须保留至少一个起点和一个目标。');
  }
  return indexes;
}
