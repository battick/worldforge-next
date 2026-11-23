import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { Store } from '../backend/server/store.ts';
import { WorkspaceRepository } from '../backend/server/workspace.ts';
import { makeExample } from '../backend/core/example.ts';
import { kindOf, objectVersion, validateState, type WorkspaceCommand, type WorkspaceState } from '../backend/core/model.ts';

async function fixture() {
  const dir = await mkdtemp(path.join(tmpdir(), 'worldforge-model-'));
  const store = new Store(dir); const repository = new WorkspaceRepository(store.db);
  const example = makeExample(0); repository.execute(example.command);
  return { dir, store, repository, ids: example.ids, example, async close() { store.close(); await rm(dir, { recursive: true, force: true }); } };
}
function migration(state: WorkspaceState, fid: string): WorkspaceCommand {
  const { version: _v, ...definition } = state.definitions.find(d => d.id === fid)!;
  return { operationId: crypto.randomUUID(), baseRevision: state.revision, changes: [
    { type: 'definition.put', definition: { ...definition, type: 'text' } },
    ...state.objects.filter(o => o.fields[fid]).map(o => ({ type: 'object.update' as const, id: o.id, set: { [fid]: o.fields[fid]!.map(String) } })),
  ] };
}

test('two worlds share a single definition and independent values; all metadata and multi-end relations stay fields', async () => {
  const f = await fixture();
  try {
    const state = f.repository.read(); validateState(state);
    assert.equal(state.worlds.length, 2); assert.equal(state.definitions.filter(d => d.id === f.ids.score).length, 1);
    const relation = state.objects.find(o => o.id === f.ids.relation)!;
    assert.equal(kindOf(relation), 'relation'); assert.equal(relation.fields[f.ids.source!]!.length, 2);
    assert.equal(state.objects.filter(o => kindOf(o) === 'relation').length, 1);
    assert.equal(relation.fields['sys.id']![0], relation.id); assert.equal(objectVersion(relation), 1);
    assert.equal(state.objects.find(o => o.id === f.ids.other)!.fields[f.ids.score!]![0], 12);
    assert.equal(f.repository.references().filter(r => r.ownerId === relation.id && r.fieldId === f.ids.source).length, 2);
    assert.throws(() => f.repository.execute({ operationId: crypto.randomUUID(), baseRevision: 1, changes: [{ type: 'object.update', id: f.ids.other, set: { [f.ids.local!]: ['不应跨世界使用'] } }] }), /其他世界/);
    assert.throws(() => f.repository.execute({ operationId: crypto.randomUUID(), baseRevision: 1, changes: [{ type: 'object.update', id: f.ids.alice, set: { 'sys.id': [crypto.randomUUID()] } }] }), /系统维护/);
    const system = state.definitions.find(d => d.id === 'sys.id')!;
    const { version: _v, ...definition } = system;
    f.repository.execute({ operationId: crypto.randomUUID(), baseRevision: 1, changes: [{ type: 'definition.put', definition: { ...definition, name: '身份凭证' } }] });
    assert.equal(f.repository.read().definitions.find(d => d.id === 'sys.id')!.name, '身份凭证');
  } finally { await f.close(); }
});

test('global definition conversion validates every world and commits definitions/values/history as one state', async () => {
  const f = await fixture();
  try {
    const before = f.repository.read(); const command = migration(before, f.ids.score!);
    assert.throws(() => f.repository.execute({ ...command, changes: command.changes.slice(0, 2) }), /文字值/);
    assert.deepEqual(f.repository.read(), before); assert.equal(f.repository.history().length, 1);
    const prepared = f.repository.prepare(command);
    assert.deepEqual(f.repository.read(), before); // preparation is never visible as a partial new definition
    assert(Object.isFrozen(prepared));
    const receipt = f.repository.commit(prepared);
    const after = f.repository.read(); validateState(after);
    assert.equal(receipt.revision, 2); assert.equal(after.definitions.find(d => d.id === f.ids.score)!.version, 2);
    assert.equal(after.objects.find(o => o.id === f.ids.other)!.fields[f.ids.score!]![0], '12');
    const history = f.repository.history()[0]!;
    assert(history.changes.some(c => c.collection === 'definitions'));
    assert(history.changes.some(c => c.collection === 'objects' && c.id === f.ids.other));
    assert.deepEqual(f.repository.execute(command), receipt); assert.equal(f.repository.history().length, 2);
    assert.throws(() => f.repository.execute({ ...command, changes: command.changes.slice(0, 1) }), /操作编号/);
    const stale = f.repository.prepare({ operationId: crypto.randomUUID(), baseRevision: 2, changes: [{ type: 'object.update', id: f.ids.alice, set: { [f.ids.name!]: ['准备中的更名'] } }] });
    f.repository.execute({ operationId: crypto.randomUUID(), baseRevision: 2, changes: [{ type: 'object.update', id: f.ids.bob, set: { [f.ids.name!]: ['先保存'] } }] });
    assert.throws(() => f.repository.commit(stale), /准备期间/);
  } finally { await f.close(); }
});

test('new definitions default to current world; value types, quantity and uniqueness use the same validator', async () => {
  const f = await fixture();
  try {
    const local = crypto.randomUUID(), flag = crypto.randomUUID(), choice = crypto.randomUUID(), structured = crypto.randomUUID(), link = crypto.randomUUID();
    const state = f.repository.read(); const { version: _v, ...score } = state.definitions.find(d => d.id === f.ids.score)!;
    const command: WorkspaceCommand = { operationId: crypto.randomUUID(), baseRevision: 1, worldId: f.ids.worldA, changes: [
      { type: 'definition.put', definition: { id: local, name: '补充', type: 'text', marks: ['title', 'summary'], constraints: { required: true, maxCount: 1, minLength: 2 } } },
      { type: 'definition.put', definition: { id: flag, name: '是否开放', type: 'boolean', marks: [], constraints: {} } },
      { type: 'definition.put', definition: { id: choice, name: '状态', type: 'choice', marks: ['classification'], constraints: { options: ['开放', '未知'] } } },
      { type: 'definition.put', definition: { id: structured, name: '坐标', type: 'json', marks: [], constraints: {} } },
      { type: 'definition.put', definition: { id: link, name: '资料链接', type: 'link', marks: [], constraints: {} } },
      { type: 'definition.put', definition: { ...score, constraints: { unique: 'world' } } },
      { type: 'object.update', id: f.ids.alice!, set: { [local]: ['人物补充'], [flag]: [true], [choice]: ['开放'], [structured]: [{ points: [1, 2], note: null }], [link]: ['https://example.com'] } },
      { type: 'object.update', id: f.ids.other!, set: { [f.ids.score!]: [3] } },
    ] };
    f.repository.execute(command);
    assert.equal(f.repository.read().definitions.find(d => d.id === local)!.scope, f.ids.worldA);
    for (const set of [{ [flag]: ['true'] }, { [choice]: ['不存在'] }, { [local]: [] }, { [local]: ['一', '二'] }, { [f.ids.score!]: [4] }, { [link]: ['javascript:alert(1)'] }]) {
      assert.throws(() => f.repository.execute({ operationId: crypto.randomUUID(), baseRevision: 2, changes: [{ type: 'object.update', id: f.ids.alice!, set }] }));
    }
    assert.equal(f.repository.read().revision, 2);
  } finally { await f.close(); }
});

test('resource versions, references and constraints reject broken changes without partial writes', async () => {
  const f = await fixture();
  try {
    const before = f.repository.read();
    const base = { operationId: crypto.randomUUID(), baseRevision: 1 };
    assert.throws(() => f.repository.execute({ ...base, changes: [{ type: 'object.delete', id: f.ids.alice }] }), /引用对象/);
    assert.throws(() => f.repository.execute({ ...base, changes: [{ type: 'definition.delete', id: f.ids.name }] }), /定义不存在/);
    assert.throws(() => f.repository.execute({ ...base, changes: [{ type: 'resource.delete', id: f.ids.file }] }), /资源/);
    const { version: _v, ...definition } = before.definitions.find(d => d.id === f.ids.score)!;
    assert.throws(() => f.repository.execute({ ...base, changes: [{ type: 'definition.put', definition: { ...definition, constraints: { min: 4 } } }] }), /超出范围/);
    assert.throws(() => f.repository.execute({ ...base, changes: [{ type: 'object.update', id: f.ids.alice, set: { [f.ids.source!]: [{ ref: crypto.randomUUID() }] } }] }), /引用对象/);
    assert.deepEqual(f.repository.read(), before);
    const content = Buffer.from('# 新正文').toString('base64');
    f.repository.execute({ ...base, changes: [
      { type: 'resource.put', id: f.ids.file, worldId: f.ids.worldA, path: 'wiki/港口.md', mime: 'text/markdown', content },
      { type: 'object.update', id: f.ids.relation, set: { [f.ids.body!]: [{ resource: f.ids.file, version: 2 }] } },
    ] });
    const after = f.repository.read();
    assert.equal(after.resourceVersions.length, 2); assert.equal(after.resourceVersions[0]!.version, 1);
    assert.equal(after.resources[0]!.version, 2); assert.equal(f.repository.history()[0]!.changes.length, 2);
    f.repository.execute({ operationId: crypto.randomUUID(), baseRevision: 2, changes: [
      { type: 'object.update', id: f.ids.relation, set: { [f.ids.source!]: [{ ref: f.ids.bob }] } }, { type: 'object.delete', id: f.ids.alice },
    ] });
    assert.throws(() => f.repository.execute({ operationId: crypto.randomUUID(), baseRevision: 3, changes: [{ type: 'object.create', id: f.ids.alice, worldId: f.ids.worldA, kind: 'entry', fields: {} }] }), /身份不可/);
  } finally { await f.close(); }
});

test('a relation can reference a complete relation without deriving pairwise edges or adding a default body', async () => {
  const f = await fixture();
  try {
    const id = crypto.randomUUID();
    f.repository.execute({ operationId: crypto.randomUUID(), baseRevision: 1, changes: [{ type: 'object.create', id, worldId: f.ids.worldA, kind: 'relation', fields: { [f.ids.source!]: [{ ref: f.ids.relation }], [f.ids.target!]: [{ ref: f.ids.alice }] } }] });
    const object = f.repository.read().objects.find(o => o.id === id)!;
    assert.equal(object.fields[f.ids.body!], undefined);
    assert.equal(f.repository.read().objects.filter(o => kindOf(o) === 'relation').length, 2);
    assert(f.repository.references().some(ref => ref.ownerId === id && ref.targetId === f.ids.relation));
    assert.equal(f.repository.read().objects.find(o => o.id === f.ids.relation)!.fields[f.ids.source!]!.length, 2);
  } finally { await f.close(); }
});

test('faults roll back rows/indexes/resources/history together; concurrent reader sees matching old state', async () => {
  const f = await fixture();
  const reader = new Database(path.join(f.dir, 'worldforge.sqlite'), { readonly: true });
  try {
    const before = f.repository.read();
    for (const stage of ['afterRows', 'beforeHistory'] as const) {
      const repo = new WorkspaceRepository(f.store.db, () => {}, point => {
        if (point === stage) {
          const definition = JSON.parse((reader.prepare('SELECT data FROM core_definitions WHERE id=?').get(f.ids.score) as { data: string }).data);
          const object = JSON.parse((reader.prepare('SELECT data FROM core_objects WHERE id=?').get(f.ids.other) as { data: string }).data);
          assert.equal(definition.type, 'number'); assert.equal(typeof object.fields[f.ids.score!][0], 'number');
          throw new Error('injected');
        }
      });
      const command = migration(before, f.ids.score!);
      command.changes.push({ type: 'resource.put', id: f.ids.file!, worldId: f.ids.worldA!, path: 'wiki/港口.md', mime: 'text/markdown', content: Buffer.from('提交失败不应留下此版本').toString('base64') });
      command.changes.push({ type: 'object.update', id: f.ids.relation!, set: { [f.ids.body!]: [{ resource: f.ids.file!, version: 2 }] } });
      assert.throws(() => repo.execute(command), /injected/);
      assert.deepEqual(repo.read(), before); assert.equal(repo.history().length, 1);
    }
    const command = migration(before, f.ids.score!);
    const repo = new WorkspaceRepository(f.store.db, () => {}, stage => { if (stage === 'afterCommit') throw new Error('response lost'); });
    assert.throws(() => repo.execute(command), /response lost/);
    assert.equal(f.repository.execute(command).revision, 2); assert.equal(f.repository.history().length, 2);
  } finally { reader.close(); await f.close(); }
});

test('actual process death during commit rolls back; after commit restart retries only once', async () => {
  const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  for (const stage of ['afterRows', 'afterCommit']) {
    const f = await fixture();
    const command = migration(f.repository.read(), f.ids.score!);
    const file = path.join(f.dir, 'command.json'); await writeFile(file, JSON.stringify(command));
    f.store.close();
    try {
      const worker = spawnSync(process.execPath, ['--import', 'tsx', 'tests/fixtures/workspace-worker.ts'], { cwd: appDir, env: { ...process.env, WORKSPACE_TEST_DIR: f.dir, WORKSPACE_TEST_COMMAND: file, WORKSPACE_TEST_STAGE: stage }, windowsHide: true, encoding: 'utf8', timeout: 15_000 });
      assert.equal(worker.status, 79, worker.stderr);
      const reopened = new Store(f.dir); const repository = new WorkspaceRepository(reopened.db);
      try {
        assert.equal(repository.read().revision, stage === 'afterRows' ? 1 : 2); validateState(repository.read());
        assert.equal(repository.execute(command).revision, 2); assert.equal(repository.history().length, 2);
        validateState(repository.read());
      } finally { reopened.close(); }
    } finally { await rm(f.dir, { recursive: true, force: true }); }
  }
});
