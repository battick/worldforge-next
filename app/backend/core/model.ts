import { z } from 'zod';
import { AppError } from './errors.ts';
import { canonicalValue, fieldValuesError } from '../../contracts/field-values.ts';
import { validateRelations } from './relations.ts';
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
    z.object({ type: z.literal('resource.put'), id, worldId: id, path: z.string().max(500), mime: z.string().min(1).max(100), content: z.string().max(1_400_000), space: z.boolean().optional() }).strict(),
    z.object({ type: z.literal('resource.delete'), id }).strict(),
  ])).min(1).max(1000),
}).strict() satisfies z.ZodType<WorkspaceCommand>;
export const canonical = canonicalValue;
export function kindOf(object: ContentObject): ObjectKind { return object.fields['sys.kind']?.[0] as ObjectKind; }
export function objectVersion(object: ContentObject): number { return object.fields['sys.version']?.[0] as number; }
export function systemDefinitions(): Definition[] {
  return roles.map(role => ({ id: `sys.${role}`, scope: 'global', name: ({ id: '身份', kind: '对象用途', created: '创建时间', updated: '修改时间', version: '数据版本' })[role], type: role === 'version' ? 'number' : 'text', marks: [role === 'id' ? 'identity' : role], constraints: { required: true, minCount: 1, maxCount: 1 }, system: role, version: 1 }));
}
function fail(path: string, message: string): never { throw new AppError('MODEL_INVALID', message, 422, { path }); }
/** Validate the complete candidate, including all worlds using a global definition. */
export function validateState(state: WorkspaceState): ReferenceIndex[] {
  const definitions = new Map(state.definitions.map(d => [d.id, d]));
  const objects = new Map(state.objects.map(o => [o.id, o]));
  const worlds = new Set(state.worlds.map(w => w.id));
  const resources = new Map(state.resources.map(r => [r.id, r]));
  const indexes: ReferenceIndex[] = validateRelations(state);
  const identities = [...state.definitions, ...state.objects, ...state.resources].map(item => item.id);
  if (new Set(identities).size !== identities.length) fail('identities', '字段、内容和资源不能共用同一身份。');
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
    const compat: Partial<Record<typeof marks[number], string[]>> = { identity: ['text'], kind: ['text'], created: ['text'], updated: ['text'], version: ['number'], title: ['text'], body: ['resource'], source: ['reference'], target: ['reference'], navigation: ['reference'], cover: ['resource'], 'world-status': ['choice'], 'navigation-folder': ['boolean'], 'relation-definition': ['boolean'], 'relation-fields': ['json'], 'relation-type': ['reference'] };
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
      const error = fieldValuesError(state, d, { ...o, kind: kindOf(o) }, values);
      if (error) fail(fp, error);
      for (const mark of ['time-start', 'time-end'] as const) if (d.marks.includes(mark)) {
        if (intervalFields.has(mark) || values.length > 1) fail(fp, '一个对象的时间开始和结束各至多一项。');
        intervalFields.add(mark);
      }
      for (const value of values) {
        if (d.type === 'reference') indexes.push({ ownerId: o.id, fieldId: fid, targetId: (value as { ref: string }).ref, kind: 'object' });
        if (d.type === 'resource') indexes.push({ ownerId: o.id, fieldId: fid, targetId: (value as { resource: string }).resource, kind: 'resource' });
      }
      if (d.marks.includes('source')) source += values.length;
      if (d.marks.includes('target')) target += values.length;
    }
    if (kindOf(o) === 'relation' && (!source || !target)) fail(p, '关系必须保留至少一个起点和一个目标。');
  }
  return indexes;
}
