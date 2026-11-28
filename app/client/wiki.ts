import { fieldValuesError } from '../contracts/field-values.ts';
import { isRelationDefinition, relationFields } from '../contracts/relations.ts';
import type { RelationField, Change, ContentObject, Definition, DefinitionInput, Resource, WorkspaceCommand, WorkspaceState } from '../contracts/workspace.ts';

export function kindOf(object: ContentObject) { return object.fields['sys.kind']?.[0] as 'world' | 'entry' | 'relation'; }
export function valuesFor(state: WorkspaceState, object: ContentObject, mark: typeof import('../contracts/workspace.ts').marks[number]) {
  return state.definitions.filter(d => d.marks.includes(mark)).flatMap(d => object.fields[d.id] ?? []);
}
export function titleOf(state: WorkspaceState, object: ContentObject) {
  return valuesFor(state, object, 'title').filter(v => typeof v === 'string' && v.trim()).join(' / ') || `未命名${kindOf(object) === 'world' ? '世界' : kindOf(object) === 'relation' ? '关系' : '条目'}`;
}
export function isFolder(state: WorkspaceState, object: ContentObject) { return valuesFor(state, object, 'navigation-folder').includes(true); }
export function worldStatus(state: WorkspaceState, object: ContentObject) { return valuesFor(state, object, 'world-status')[0]; }
export function locationsOf(state: WorkspaceState, object: ContentObject) {
  return valuesFor(state, object, 'navigation').flatMap(v => v && typeof v === 'object' && 'ref' in v ? [String(v.ref)] : []);
}
export function encodeBytes(bytes: Uint8Array) {
  let binary = ''; for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(binary);
}
export function encodeText(text: string) { return encodeBytes(new TextEncoder().encode(text)); }
export function resourceText(state: WorkspaceState, id: string, version: number) {
  const saved = state.resourceVersions.find(r => r.id === id && r.version === version);
  if (!saved) throw new Error('找不到指定资料版本。');
  const bytes = Uint8Array.from(atob(saved.content), c => c.charCodeAt(0));
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { return new TextDecoder('gb18030', { fatal: true }).decode(bytes); }
}
export function bodyRefs(state: WorkspaceState, object: ContentObject) {
  return state.definitions.filter(d => d.marks.includes('body')).flatMap(d => (object.fields[d.id] ?? []).flatMap(v => {
    if (!v || typeof v !== 'object' || !('resource' in v) || !('version' in v)) return [];
    return [{ fieldId: d.id, fieldName: d.name, resource: String(v.resource), version: Number(v.version) }];
  }));
}
export function command(state: WorkspaceState, worldId: string, changes: Change[]): WorkspaceCommand {
  return { operationId: crypto.randomUUID(), baseRevision: state.revision, worldId, changes };
}
function candidateState(state: WorkspaceState, changes: Change[]): WorkspaceState {
  const next = { ...state, definitions: [...state.definitions], resources: [...state.resources], resourceVersions: [...state.resourceVersions] };
  for (const c of changes) {
    if (c.type === 'definition.put') next.definitions.push({ ...c.definition, scope: c.definition.scope!, version: 1 });
    if (c.type === 'resource.put') { const version = (state.resources.find(r => r.id === c.id)?.version ?? 0) + 1; next.resources.push({ id: c.id, worldId: c.worldId, path: c.path, version, space: c.space }); next.resourceVersions.push({ id: c.id, version, mime: c.mime, content: c.content, hash: '' }); }
  }
  return next;
}
export function ensureField(state: WorkspaceState, worldId: string, changes: Change[], mark: Definition['marks'][number], name: string, type: DefinitionInput['type'], constraints: DefinitionInput['constraints'] = {}, values: unknown[] = [], ownerId = '', kind: 'world' | 'entry' | 'relation' = 'entry') {
  const candidate = candidateState(state, changes);
  const existing = candidate.definitions.filter(d => !d.system && (d.scope === worldId || d.scope === 'global') && d.type === type && d.marks.includes(mark)
    && (d.constraints.maxCount ?? Infinity) >= Math.max(1, values.length)
    && (!constraints.options || constraints.options.every(value => d.constraints.options?.includes(value)))
    && !fieldValuesError(candidate, d, { id: ownerId, worldId, kind }, values))
    .sort((a, b) => Number(b.scope === worldId) - Number(a.scope === worldId))[0];
  if (existing) return existing.id;
  const id = crypto.randomUUID(); changes.push({ type: 'definition.put', definition: { id, name, type, marks: [mark], constraints, scope: worldId } }); return id;
}
const ensure = ensureField;
export interface SourceFile { name: string; mime: string; content: string }
export function newWorld(state: WorkspaceState, name: string, idea: string, source?: SourceFile) {
  const worldId = crypto.randomUUID(), changes: Change[] = [{ type: 'world.create', id: worldId }];
  const resource = crypto.randomUUID();
  changes.push({ type: 'resource.put', id: resource, worldId, path: `wiki/${worldId}.md`, mime: 'text/markdown', content: encodeText(idea), space: false });
  const title = ensure(state, worldId, changes, 'title', '名称', 'text', {}, name.trim() ? [name.trim()] : [], worldId, 'world');
  const body = ensure(state, worldId, changes, 'body', '正文', 'resource', {}, [{ resource, version: 1 }], worldId, 'world');
  const status = ensure(state, worldId, changes, 'world-status', '创建进度', 'choice', { options: ['draft', 'created'], maxCount: 1 }, ['draft'], worldId, 'world');
  changes.push({ type: 'object.update', id: worldId, set: { ...(name.trim() ? { [title]: [name.trim()] } : {}), [body]: [{ resource, version: 1 }], [status]: ['draft'] } });
  if (source) changes.push({ type: 'resource.put', id: crypto.randomUUID(), worldId, path: `资料/${source.name}`, mime: source.mime, content: source.content });
  return { worldId, command: command(state, worldId, changes) };
}
export function confirmWorld(state: WorkspaceState, worldId: string) {
  const changes: Change[] = [], field = ensure(state, worldId, changes, 'world-status', '创建进度', 'choice', { options: ['draft', 'created'], maxCount: 1 }, ['created'], worldId, 'world');
  changes.push({ type: 'object.update', id: worldId, set: { [field]: ['created'] } }); return command(state, worldId, changes);
}
export function newObject(state: WorkspaceState, worldId: string, name: string, kind: 'entry' | 'relation', sources: string[] = [], targets: string[] = [], folder = false, location?: string, relationDefinitionId?: string, extraFields: Record<string, unknown[]> = {}) {
  const id = crypto.randomUUID(), changes: Change[] = [];
  const title = ensure(state, worldId, changes, 'title', '名称', 'text', {}, name.trim() ? [name.trim()] : [], id, kind);
  const fields: Record<string, unknown[]> = name.trim() ? { [title]: [name.trim()] } : {};
  if (kind === 'entry' && !folder) {
    const resource = crypto.randomUUID();
    changes.push({ type: 'resource.put', id: resource, worldId, path: `wiki/${id}.md`, mime: 'text/markdown', content: '', space: false });
    const body = ensure(state, worldId, changes, 'body', '正文', 'resource', {}, [{ resource, version: 1 }], id, kind);
    fields[body] = [{ resource, version: 1 }];
  }
  if (kind === 'relation') {
    const template = relationDefinitionId ? state.objects.find(o => o.id === relationDefinitionId && isRelationDefinition(state, o)) : undefined;
    if (relationDefinitionId && !template) throw new Error('所选关系定义不存在。');
    const configs = template ? relationFields(state, template) : [];
    for (const config of configs) fields[config.fieldId] = structuredClone(config.defaults ?? []);
    Object.assign(fields, extraFields);
    const configured = (mark: 'source' | 'target') => configs.map(c => state.definitions.find(d => d.id === c.fieldId)!).find(d => d.marks.includes(mark));
    const source = configured('source')?.id ?? ensure(state, worldId, changes, 'source', '关系起点', 'reference', {}, sources.map(ref => ({ ref })), id, kind);
    const target = configured('target')?.id ?? ensure(state, worldId, changes, 'target', '关系目标', 'reference', {}, targets.map(ref => ({ ref })), id, kind);
    const sameEndpoints = JSON.stringify([...new Set(sources)].sort()) === JSON.stringify([...new Set(targets)].sort());
    if (!sameEndpoints && candidateState(state, changes).definitions.some(d => (d.id === source || d.id === target) && d.marks.includes('source') && d.marks.includes('target'))) {
      throw new Error('同一字段同时用作起点和目标，无法保存两组不同端点。请在关系定义中分别采用起点、目标字段，再创建关系。');
    }
    if (template) fields[ensure(state, worldId, changes, 'relation-type', '关系定义', 'reference', { maxCount: 1 }, [{ ref: template.id }], id, kind)] = [{ ref: template.id }];
    fields[source] = sources.map(ref => ({ ref })); fields[target] = targets.map(ref => ({ ref }));
    if (name.trim()) fields[title] = [name.trim()];
  }
  if (folder) fields[ensure(state, worldId, changes, 'navigation-folder', '导航文件夹', 'boolean', { maxCount: 1 }, [true], id, kind)] = [true];
  if (location) fields[ensure(state, worldId, changes, 'navigation', '位置', 'reference', { sameWorld: true }, [{ ref: location }], id, kind)] = [{ ref: location }];
  changes.push({ type: 'object.create', id, worldId, kind, fields });
  return { id, command: command(state, worldId, changes) };
}
export interface BodyDraft { fieldId?: string; resourceId?: string; text: string }
export function saveEntry(state: WorkspaceState, object: ContentObject, fields: Record<string, unknown[]>, bodies: BodyDraft[] = []) {
  const changes: Change[] = [], set = structuredClone(fields);
  const resources = new Map<string, { text: string; version: number }>();
  for (const draft of bodies) {
    const id = draft.resourceId ?? crypto.randomUUID(), existing = state.resources.find(r => r.id === id);
    if (draft.fieldId && draft.resourceId && !(set[draft.fieldId] ?? []).some(v => v && typeof v === 'object' && 'resource' in v && v.resource === id)) throw new Error('编辑过的正文引用已移除，请恢复引用或取消本次编辑后再保存。');
    const ref = bodyRefs(state, { ...object, fields: { ...object.fields, ...set } }).find(r => r.resource === id && r.fieldId === draft.fieldId);
    if (ref && existing && ref.version !== existing.version && state.resourceVersions.find(v => v.id === id && v.version === ref.version)?.hash !== state.resourceVersions.find(v => v.id === id && v.version === existing.version)?.hash) throw new Error('正文资源已有更新版本。请核对版本后再编辑，当前文字已保留。');
    const previous = resources.get(id);
    if (previous && previous.text !== draft.text) throw new Error('同一正文资源有两份不同草稿，请先统一内容再保存。');
    const version = previous?.version ?? (existing?.version ?? 0) + 1;
    if (!previous) changes.push({ type: 'resource.put', id, worldId: existing?.worldId ?? object.worldId, path: existing?.path ?? `wiki/${id}.md`, mime: 'text/markdown', content: encodeText(draft.text), space: existing?.space ?? false });
    resources.set(id, { text: draft.text, version });
    const fid = draft.fieldId ?? ensure(state, object.worldId, changes, 'body', '正文', 'resource', {}, [{ resource: id, version }], object.id, kindOf(object));
    const old = set[fid] ?? [], value = { resource: id, version };
    set[fid] = old.some(v => v && typeof v === 'object' && 'resource' in v && v.resource === id) ? old.map(v => v && typeof v === 'object' && 'resource' in v && v.resource === id ? value : v) : [...old, value];
  }
  changes.push({ type: 'object.update', id: object.id, set, unset: Object.keys(object.fields).filter(id => !id.startsWith('sys.') && !(id in set)) });
  return command(state, object.worldId, changes);
}
export function saveBody(state: WorkspaceState, object: ContentObject, markdown: string, fieldId?: string, resourceId?: string) {
  return saveEntry(state, object, Object.fromEntries(Object.entries(object.fields).filter(([id]) => !id.startsWith('sys.'))), [{ text: markdown, fieldId, resourceId }]);
}
export function relationDefinitionCommand(state: WorkspaceState, worldId: string, name: string, configs: RelationField[], existingId?: string) {
  const changes: Change[] = [], id = existingId ?? crypto.randomUUID();
  configs = structuredClone(configs);
  for (const mark of ['source', 'target'] as const) if (!configs.some(c => state.definitions.find(d => d.id === c.fieldId)?.marks.includes(mark))) configs.push({ fieldId: ensure(state, worldId, changes, mark, mark === 'source' ? '关系起点' : '关系目标', 'reference', {}, [], id, 'relation') });
  const existing = state.objects.find(o => o.id === existingId);
  const own = (mark: Definition['marks'][number]) => state.definitions.find(d => d.marks.includes(mark) && existing && d.id in existing.fields)?.id;
  const title = own('title') ?? ensure(state, worldId, changes, 'title', '名称', 'text', {}, [name], id);
  const marker = own('relation-definition') ?? ensure(state, worldId, changes, 'relation-definition', '关系定义用途', 'boolean', { maxCount: 1 }, [true], id);
  const configuration = own('relation-fields') ?? ensure(state, worldId, changes, 'relation-fields', '采用字段', 'json', {}, configs, id);
  const fields = { [title]: [name], [marker]: [true], [configuration]: configs };
  changes.push(existingId ? { type: 'object.update', id, set: fields, unset: state.definitions.filter(d => d.id !== configuration && d.marks.includes('relation-fields') && existing && d.id in existing.fields).map(d => d.id) } : { type: 'object.create', id, worldId, kind: 'entry', fields });
  return { id, command: command(state, worldId, changes) };
}
export function searchableText(state: WorkspaceState, object: ContentObject) {
  const fields = Object.entries(object.fields).filter(([id]) => !id.startsWith('sys.')).flatMap(([, values]) => values).filter(v => ['string', 'number', 'boolean'].includes(typeof v)).join('\n');
  const bodies = bodyRefs(state, object).map(ref => { try { return resourceText(state, ref.resource, ref.version); } catch { return ''; } }).join('\n');
  return fields + '\n' + bodies;
}
export function searchObjects(state: WorkspaceState, worldId: string, query: string, fieldId = '', value = '') {
  const term = query.toLocaleLowerCase();
  return state.objects.filter(o => o.worldId === worldId && kindOf(o) !== 'world' && (!fieldId || fieldId in o.fields)
    && (!value || (o.fields[fieldId] ?? []).some(v => JSON.stringify(v).toLocaleLowerCase().includes(value.toLocaleLowerCase()))))
    .flatMap(object => {
      const text = searchableText(state, object), index = text.toLocaleLowerCase().indexOf(term);
      return term && index < 0 ? [] : [{ object, snippet: text.slice(Math.max(0, index - 25), Math.max(0, index - 25) + 150) }];
    });
}
export function moveResources(state: WorkspaceState, worldId: string, source: string, destination: string, copy = false, spaceOnly = false) {
  const changes = state.resources.filter(r => r.worldId === worldId && (!spaceOnly || r.space !== false) && (r.path === source || r.path.startsWith(source + '/'))).map((r): Change => {
    const saved = state.resourceVersions.find(v => v.id === r.id && v.version === r.version)!;
    return { type: 'resource.put', id: copy ? crypto.randomUUID() : r.id, worldId, path: destination + r.path.slice(source.length), mime: saved.mime, content: saved.content, space: r.space };
  });
  if (!changes.length) throw new Error('找不到要操作的文件或目录。');
  return command(state, worldId, changes);
}
export function resourceChange(resource: Resource, content: string, mime: string): Change {
  return { type: 'resource.put', id: resource.id, worldId: resource.worldId, path: resource.path, mime, content, space: resource.space };
}
export function relocate(state: WorkspaceState, object: ContentObject, destination: string, from?: string, add = false) {
  if (isFolder(state, object) && state.objects.some(o => o.id !== object.id && o.worldId === object.worldId && isFolder(state, o) && titleOf(state, o) === titleOf(state, object) && (destination ? locationsOf(state, o).includes(destination) : !locationsOf(state, o).length))) throw new Error('目标位置有同名文件夹，请先改名或取消，不会自动合并。');
  if (destination) {
    const target = state.objects.find(o => o.id === destination);
    if (!target || !isFolder(state, target) || target.worldId !== object.worldId) throw new Error('目标需要是当前世界的文件夹。');
    if (isFolder(state, object)) {
      const pending = [destination], seen = new Set<string>();
      while (pending.length) {
        const id = pending.pop()!; if (id === object.id) throw new Error('不能移动到自身或其下级位置。');
        if (seen.has(id)) continue; seen.add(id);
        const parent = state.objects.find(o => o.id === id); if (parent) pending.push(...locationsOf(state, parent));
      }
    }
  }
  const current = locationsOf(state, object);
  if (!add && current.length && !from) throw new Error('请先在具体文件夹中打开条目，明确要移动哪一处位置。');
  const changes: Change[] = [], set: Record<string, unknown[]> = {};
  const navigation = state.definitions.filter(d => d.marks.includes('navigation') && d.type === 'reference');
  for (const d of navigation) if (d.id in object.fields) set[d.id] = (object.fields[d.id] ?? []).filter(v => add || !v || typeof v !== 'object' || !('ref' in v) || v.ref !== from);
  if (destination && !Object.values(set).flat().some(v => v && typeof v === 'object' && 'ref' in v && v.ref === destination)) {
    const id = navigation.find(d => d.id in set)?.id ?? ensure(state, object.worldId, changes, 'navigation', '位置', 'reference', { sameWorld: true }, [{ ref: destination }], object.id, kindOf(object));
    set[id] = [...(set[id] ?? []), { ref: destination }];
  }
  changes.push({ type: 'object.update', id: object.id, set });
  return command(state, object.worldId, changes);
}
