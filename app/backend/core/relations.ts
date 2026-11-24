import { z } from 'zod';
import { AppError } from './errors.ts';
import { fieldValuesError } from '../../contracts/field-values.ts';
import { isRelationDefinition, relationFields, relationTypeId, markedValues } from '../../contracts/relations.ts';
import type { ContentObject, ReferenceIndex, WorkspaceState } from '../../contracts/workspace.ts';

const configuration = z.object({ fieldId: z.string().uuid(), defaults: z.array(z.unknown()).optional() }).strict();
function invalid(message: string): never { throw new AppError('MODEL_INVALID', message, 422); }
export function validateRelations(state: WorkspaceState): ReferenceIndex[] {
  const indexes: ReferenceIndex[] = [];
  for (const object of state.objects) {
    const template = isRelationDefinition(state, object);
    if (markedValues(state, object, 'relation-definition').some(v => typeof v !== 'boolean') || template && object.fields['sys.kind']?.[0] !== 'entry') invalid('关系定义用途需要普通条目。');
    const configs = relationFields(state, object);
    if (configs.length && !template) invalid('关系字段配置只能放在关系定义条目上。');
    const seen = new Set<string>();
    for (const raw of configs) {
      const parsed = configuration.safeParse(raw);
      if (!parsed.success) invalid('关系字段配置需要fieldId和可选的defaults值数组。');
      const config = parsed.data, definition = state.definitions.find(d => d.id === config.fieldId);
      if (!definition || definition.system || definition.marks.some(m => ['relation-definition', 'relation-fields', 'relation-type'].includes(m))) invalid('关系配置需要现存的普通字段，不能递归配置关系管理字段。');
      if (definition.scope !== 'global' && definition.scope !== object.worldId) invalid('关系配置不能采用其他世界的本地字段。');
      if (config.defaults) { const error = fieldValuesError(state, { ...definition, constraints: { ...definition.constraints, unique: undefined } }, { id: object.id, worldId: object.worldId, kind: 'relation' }, config.defaults); if (error) invalid(`关系字段初始值不合法：${error}`); }
      if (seen.has(config.fieldId)) invalid('关系配置的字段不能重复。'); seen.add(config.fieldId);
      const fieldId = state.definitions.find(d => d.marks.includes('relation-fields') && (object.fields[d.id] ?? []).includes(raw))!.id;
      indexes.push({ ownerId: object.id, fieldId, targetId: config.fieldId, kind: 'definition' });
    }
    const types = markedValues(state, object, 'relation-type');
    if (types.length > 1 || types.length && object.fields['sys.kind']?.[0] !== 'relation') invalid('关系实例至多采用一份关系定义。');
    if (types.length) {
      const id = relationTypeId(state, object), target = state.objects.find(o => o.id === id);
      if (!target || !isRelationDefinition(state, target)) invalid('关系定义引用必须指向带有关系定义用途的条目。');
    }
  }
  return indexes;
}

/** Apply configuration in the same candidate/transaction. Never replace user values or erase removed fields. */
export function synchronizeRelations(state: WorkspaceState): string[] {
  validateRelations(state);
  const touched: string[] = [];
  for (const object of state.objects) {
    const type = relationTypeId(state, object); if (!type) continue;
    const template = state.objects.find(o => o.id === type)!;
    for (const config of relationFields(state, template)) if (!(config.fieldId in object.fields)) {
      object.fields[config.fieldId] = structuredClone(config.defaults ?? []); touched.push(object.id);
    }
  }
  return [...new Set(touched)];
}
