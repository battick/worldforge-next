import type { WorkspaceCommand } from './model.ts';

/** Explicit, fictional example; never runs at startup or overwrites existing data. */
export function makeExample(baseRevision: number) {
  const ids = Object.fromEntries(['worldA', 'worldB', 'name', 'score', 'local', 'source', 'target', 'body', 'alice', 'bob', 'port', 'relation', 'other', 'file'].map(key => [key, crypto.randomUUID()])) as Record<string, string>;
  const d = (key: string, name: string, type: 'text' | 'number' | 'reference' | 'resource', marks: ('title' | 'body' | 'source' | 'target' | 'classification')[] = [], scope = 'global'): WorkspaceCommand['changes'][number] => ({ type: 'definition.put', definition: { id: ids[key]!, name, type, scope, marks, constraints: {} } });
  const obj = (key: string, name: string, world: string, score: number): WorkspaceCommand['changes'][number] => ({ type: 'object.create', id: ids[key]!, worldId: ids[world]!, kind: 'entry', fields: { [ids.name!]: [name], [ids.score!]: [score] } });
  const markdown = '# 港口笔记\n\n灯塔尚未熄灭。';
  const bytes = new TextEncoder().encode(markdown);
  const content = btoa(Array.from(bytes, byte => String.fromCharCode(byte)).join(''));
  const command: WorkspaceCommand = { operationId: crypto.randomUUID(), baseRevision, changes: [
    { type: 'world.create', id: ids.worldA! }, { type: 'world.create', id: ids.worldB! },
    d('name', '名称', 'text', ['title']), d('score', '等级', 'number'), d('local', '魔力体系', 'text', ['classification'], ids.worldA!),
    d('source', '参与者', 'reference', ['source']), d('target', '所属地点', 'reference', ['target']), d('body', '正文', 'resource', ['body']),
    obj('alice', '艾琳', 'worldA', 3), obj('bob', '博恩', 'worldA', 4), obj('port', '白鹭港', 'worldA', 8), obj('other', '另一个世界的港口', 'worldB', 12),
    { type: 'resource.put', id: ids.file!, worldId: ids.worldA!, path: 'wiki/港口.md', mime: 'text/markdown', content },
    { type: 'object.update', id: ids.worldA!, set: { [ids.name!]: ['雾海'], [ids.local!]: ['灯火'] } },
    { type: 'object.update', id: ids.worldB!, set: { [ids.name!]: ['星原'] } },
    { type: 'object.create', id: ids.relation!, worldId: ids.worldA!, kind: 'relation', fields: { [ids.source!]: [{ ref: ids.alice! }, { ref: ids.bob! }], [ids.target!]: [{ ref: ids.port! }], [ids.name!]: ['共同驻守'], [ids.body!]: [{ resource: ids.file!, version: 1 }] } },
  ] };
  return { ids, command };
}
