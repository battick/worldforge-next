import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Store } from '../backend/server/store.ts';
import { WorkspaceRepository } from '../backend/server/workspace.ts';
import { Collaboration } from '../backend/server/collaboration.ts';
import { bodyRefs, command, encodeText, ensureField, moveResources, newObject, newWorld, relationDefinitionCommand, resourceChange, resourceText, saveBody, saveEntry, titleOf } from '../client/wiki.ts';
import { relationFields } from '../contracts/relations.ts';
import type { Change, ContentObject, DefinitionInput, WorkspaceState } from '../contracts/workspace.ts';

async function fixture() {
  const dir = await mkdtemp(path.join(tmpdir(), 'worldforge-review-fixes-'));
  const store = new Store(dir), repo = new WorkspaceRepository(store.db);
  return { store, repo, async close() { store.close(); await rm(dir, { recursive: true, maxRetries: 5, retryDelay: 50 }); } };
}
const fields = (object: ContentObject) => Object.fromEntries(Object.entries(object.fields).filter(([id]) => !id.startsWith('sys.')));
function world(repo: WorkspaceRepository) { const result = newWorld(repo.read(), '界', ''); repo.execute(result.command); return result.worldId; }
function entry(repo: WorkspaceRepository, worldId: string, name: string) { const result = newObject(repo.read(), worldId, name, 'entry'); repo.execute(result.command); return result.id; }
function definition(id: string, overrides: Partial<DefinitionInput> = {}): DefinitionInput { return { id, scope: 'global', name: '名称', type: 'text', marks: ['title'], constraints: {}, ...overrides }; }

test('one entry command commits body and fields together, rejects invalid edits without partial writes and retains retry identity', async () => {
  const f = await fixture();
  try {
    const wid = world(f.repo), id = entry(f.repo, wid, '原名');
    let state = f.repo.read(), object = state.objects.find(o => o.id === id)!, body = bodyRefs(state, object)[0]!;
    const title = state.definitions.find(d => d.marks.includes('title') && d.id in object.fields)!;
    const draft = saveEntry(state, object, { ...fields(object), [title.id]: ['新名'] }, [{ fieldId: body.fieldId, resourceId: body.resource, text: '# 新正文' }]);
    assert.equal(draft.changes.filter(c => c.type === 'object.update').length, 1);
    const receipt = f.repo.execute(draft); assert.deepEqual(f.repo.execute(draft), receipt);
    state = f.repo.read(); object = state.objects.find(o => o.id === id)!; body = bodyRefs(state, object)[0]!;
    assert.equal(titleOf(state, object), '新名'); assert.equal(resourceText(state, body.resource, body.version), '# 新正文');
    assert.equal(body.version, 2); assert.equal(f.repo.history().filter(h => h.operationId === draft.operationId).length, 1);
    const before = f.repo.read(), count = f.repo.history().length;
    const invalid = saveEntry(before, object, { ...fields(object), [title.id]: [17] }, [{ fieldId: body.fieldId, resourceId: body.resource, text: '不能部分保存' }]);
    assert.throws(() => f.repo.execute(invalid), /需要文字值/); assert.deepEqual(f.repo.read(), before); assert.equal(f.repo.history().length, count);
    const stale = saveEntry(before, object, { ...fields(object), [title.id]: ['本地草稿'] }, [{ fieldId: body.fieldId, resourceId: body.resource, text: '本地正文' }]);
    f.repo.execute(command(before, wid, [{ type: 'object.update', id, set: { [title.id]: ['外部修改'] } }]));
    assert.throws(() => f.repo.execute(stale), /资料已改变/);
    assert.equal(resourceText(f.repo.read(), body.resource, body.version), '# 新正文');
  } finally { await f.close(); }
});

test('reuse chooses a fully compatible definition across length, uniqueness and reference constraints', async () => {
  const f = await fixture();
  try {
    const short = '10000000-0000-4000-8000-000000000001', suitable = '10000000-0000-4000-8000-000000000002';
    f.repo.execute({ operationId: crypto.randomUUID(), baseRevision: 0, changes: [
      { type: 'definition.put', definition: definition(short, { constraints: { maxLength: 1, unique: 'workspace' } }) },
      { type: 'definition.put', definition: definition(suitable, { constraints: { maxLength: 100 } }) },
    ] });
    const wid = world(f.repo), id = entry(f.repo, wid, '艾琳');
    let state = f.repo.read(), object = state.objects.find(o => o.id === id)!;
    assert.deepEqual(object.fields[suitable], ['艾琳']); assert(!(short in object.fields));
    const same = entry(f.repo, wid, '界'); state = f.repo.read(); object = state.objects.find(o => o.id === same)!;
    assert.deepEqual(object.fields[suitable], ['界']); // The short field is already used by the world.
    const restricted = crypto.randomUUID(), free = crypto.randomUUID();
    f.repo.execute(command(state, wid, [
      { type: 'definition.put', definition: definition(restricted, { type: 'reference', marks: ['source'], constraints: { targetKinds: ['entry'], sameWorld: true } }) },
      { type: 'definition.put', definition: definition(free, { type: 'reference', marks: ['source'], constraints: { targetKinds: ['world'] } }) },
    ]));
    const changes: Change[] = []; state = f.repo.read();
    assert.equal(ensureField(state, wid, changes, 'source', '起点', 'reference', {}, [{ ref: wid }], crypto.randomUUID(), 'relation'), free);
    assert.deepEqual(changes, []);
  } finally { await f.close(); }
});

test('legacy membership survives renaming, detached bodies and source references without rewriting originals', async () => {
  const f = await fixture();
  try {
    const wid = world(f.repo), id = entry(f.repo, wid, '原件');
    let state = f.repo.read(), object = state.objects.find(o => o.id === id)!, body = bodyRefs(state, object)[0]!;
    const source = crypto.randomUUID();
    f.repo.execute(command(state, wid, [{ type: 'resource.put', id: source, worldId: wid, path: 'wiki/参考.md', mime: 'text/markdown', content: encodeText('原始资料') }]));
    state = f.repo.read();
    const bodyResource = state.resources.find(r => r.id === body.resource)!;
    f.repo.execute(moveResources(state, wid, bodyResource.path, 'wiki/归档正文.md'));
    f.repo.execute(command(f.repo.read(), wid, [{ type: 'object.update', id, set: { [body.fieldId]: [{ resource: source, version: 1 }] } }]));
    // Simulate the pre-fix serialized rows/history only in this isolated database.
    for (const table of ['core_resources', 'core_history']) for (const row of f.store.db.prepare(`SELECT rowid, data FROM ${table}`).all() as { rowid: number; data: string }[]) {
      const value = JSON.parse(row.data);
      if (table === 'core_resources') delete value.space;
      else for (const change of value.changes) if (change.collection === 'resources') for (const key of ['before', 'after']) if (change[key]) delete change[key].space;
      f.store.db.prepare(`UPDATE ${table} SET data=? WHERE rowid=?`).run(JSON.stringify(value), row.rowid);
    }
    const raw = f.store.db.prepare('SELECT data FROM core_resources ORDER BY id').all();
    state = f.repo.read(); assert.equal(state.resources.find(r => r.id === body.resource)!.space, false);
    assert.equal(state.resources.find(r => r.id === source)!.space, true);
    assert.deepEqual(f.store.db.prepare('SELECT data FROM core_resources ORDER BY id').all(), raw);
    const originalVersions = structuredClone(state.resourceVersions), historyCount = f.repo.history().length;
    f.repo.read(); assert.equal(f.repo.history().length, historyCount); assert.deepEqual(f.repo.read().resourceVersions, originalVersions);
    const membership = new WorkspaceRepository(f.store.db).read(); assert.equal(membership.resources.find(r => r.id === body.resource)!.space, false);
    const move = moveResources(state, wid, 'wiki', '归档', false, true); assert.deepEqual(move.changes.map(c => 'id' in c ? c.id : ''), [source]); f.repo.execute(move);
    state = f.repo.read(); object = state.objects.find(o => o.id === id)!;
    f.repo.execute(saveBody(state, object, '资料用于正文后仍属空间', body.fieldId, source));
    state = f.repo.read(); assert.equal(state.resources.find(r => r.id === source)!.space, true); assert.equal(resourceText(state, source, 1), '原始资料');
    assert.equal(state.resources.find(r => r.id === body.resource)!.path, 'wiki/归档正文.md');
  } finally { await f.close(); }
});

test('relation configuration propagates atomically, preserves values and records affected instances in history', async () => {
  const f = await fixture();
  try {
    const wid = world(f.repo), a = entry(f.repo, wid, '甲'), b = entry(f.repo, wid, '乙');
    const number = crypto.randomUUID();
    f.repo.execute(command(f.repo.read(), wid, [{ type: 'definition.put', definition: definition(number, { scope: wid, name: '加入年', type: 'number', marks: [], constraints: { min: 0 } }) }]));
    const template = relationDefinitionCommand(f.repo.read(), wid, '师徒', []); f.repo.execute(template.command);
    const relations: string[] = [1, 2].map(i => { const result = newObject(f.repo.read(), wid, `师徒${i}`, 'relation', [a, wid], [b], false, undefined, template.id); f.repo.execute(result.command); return result.id; });
    let state = f.repo.read(), object = state.objects.find(o => o.id === template.id)!;
    const update = relationDefinitionCommand(state, wid, '师徒', [...relationFields(state, object), { fieldId: number, defaults: [3] }], template.id);
    const receipt = f.repo.execute(update.command); assert.deepEqual(f.repo.execute(update.command), receipt);
    state = f.repo.read();
    for (const id of relations) assert.deepEqual(state.objects.find(o => o.id === id)!.fields[number], [3]);
    assert.equal(f.repo.history()[0]!.changes.filter(c => relations.includes(c.id)).length, 2);
    assert(f.repo.references().some(r => r.ownerId === template.id && r.targetId === number && r.kind === 'definition'));
    f.repo.execute(command(state, wid, [{ type: 'object.update', id: relations[0]!, set: { [number]: [9] } }]));
    state = f.repo.read(); object = state.objects.find(o => o.id === template.id)!;
    f.repo.execute(relationDefinitionCommand(state, wid, '师徒', relationFields(state, object).map(c => c.fieldId === number ? { ...c, defaults: [4] } : c), template.id).command);
    state = f.repo.read(); assert.deepEqual(state.objects.find(o => o.id === relations[0])!.fields[number], [9]); assert.deepEqual(state.objects.find(o => o.id === relations[1])!.fields[number], [3]);
    const before = f.repo.read(), historyCount = f.repo.history().length;
    assert.throws(() => f.repo.execute(command(before, wid, [{ type: 'definition.delete', id: number }])), /关系配置需要/); assert.deepEqual(f.repo.read(), before);
    const required = crypto.randomUUID();
    const invalid = relationDefinitionCommand(before, wid, '师徒', [...relationFields(before, before.objects.find(o => o.id === template.id)!), { fieldId: required }], template.id);
    invalid.command.changes.unshift({ type: 'definition.put', definition: definition(required, { scope: wid, name: '必须填写', type: 'number', marks: [], constraints: { required: true } }) });
    assert.throws(() => f.repo.execute(invalid.command), /数量/); assert.deepEqual(f.repo.read(), before); assert.equal(f.repo.history().length, historyCount);
    const typeChange = definition(number, { scope: wid, name: '加入年', type: 'text', marks: [], constraints: {} });
    assert.throws(() => f.repo.execute(command(before, wid, [{ type: 'definition.put', definition: typeChange }])), /初始值不合法/);
    const configField = before.definitions.find(d => d.marks.includes('relation-fields') && d.id in before.objects.find(o => o.id === template.id)!.fields)!.id;
    f.repo.execute(command(before, wid, [
      { type: 'definition.put', definition: typeChange },
      { type: 'object.update', id: template.id, set: { [configField]: relationFields(before, before.objects.find(o => o.id === template.id)!).map(c => c.fieldId === number ? { fieldId: number, defaults: ['4'] } : c) } },
      ...relations.map((id, i): Change => ({ type: 'object.update', id, set: { [number]: [i ? '3' : '9'] } })),
    ]));
    state = f.repo.read(); assert.deepEqual(state.objects.find(o => o.id === relations[0])!.fields[number], ['9']);
    const detached = relationDefinitionCommand(state, wid, '师徒', relationFields(state, state.objects.find(o => o.id === template.id)!).filter(c => c.fieldId !== number), template.id);
    f.repo.execute(detached.command); assert.deepEqual(f.repo.read().objects.find(o => o.id === relations[0])!.fields[number], ['9']);
  } finally { await f.close(); }
});


test('an explicit relation name takes precedence over defaults and the empty title value sent by the form', async () => {
  const f = await fixture();
  try {
    const wid = world(f.repo), title = f.repo.read().definitions.find(d => d.marks.includes('title'))!.id;
    for (const defaults of [[], ['默认名称']]) {
      const template = relationDefinitionCommand(f.repo.read(), wid, '命名配置', [{ fieldId: title, defaults }]); f.repo.execute(template.command);
      const relation = newObject(f.repo.read(), wid, '明确名称', 'relation', [wid], [wid], false, undefined, template.id, { [title]: [] }); f.repo.execute(relation.command);
      assert.equal(titleOf(f.repo.read(), f.repo.read().objects.find(o => o.id === relation.id)!), '明确名称');
      const unnamed = newObject(f.repo.read(), wid, '', 'relation', [wid], [wid], false, undefined, template.id); f.repo.execute(unnamed.command);
      assert.deepEqual(f.repo.read().objects.find(o => o.id === unnamed.id)!.fields[title], defaults);
    }
  } finally { await f.close(); }
});

test('dual endpoint marks remain supported but incompatible endpoint inputs cannot silently overwrite one another', async () => {
  const f = await fixture();
  try {
    const wid = world(f.repo), a = entry(f.repo, wid, '甲'), b = entry(f.repo, wid, '乙'), dual = crypto.randomUUID();
    f.repo.execute(command(f.repo.read(), wid, [{ type: 'definition.put', definition: definition(dual, { scope: wid, type: 'reference', marks: ['source', 'target'] }) }]));
    const before = f.repo.read();
    assert.throws(() => newObject(before, wid, '甲到乙', 'relation', [a], [b])); assert.deepEqual(f.repo.read(), before);
    const template = relationDefinitionCommand(before, wid, '双用途', [{ fieldId: dual }]); f.repo.execute(template.command);
    assert.throws(() => newObject(f.repo.read(), wid, '甲到乙', 'relation', [a], [b], false, undefined, template.id));
    const loop = newObject(f.repo.read(), wid, '相同两端', 'relation', [a, b], [b, a], false, undefined, template.id); f.repo.execute(loop.command);
    assert.deepEqual(f.repo.read().objects.find(o => o.id === loop.id)!.fields[dual], [{ ref: b }, { ref: a }]);
    assert.deepEqual(f.repo.read().definitions.find(d => d.id === dual)!.marks, ['source', 'target']);
  } finally { await f.close(); }
});

test('deleted protection targets can be unprotected by their saved version but cannot be protected again', async () => {
  const f = await fixture(), service = new Collaboration(f.store.db, f.repo);
  try {
    const wid = world(f.repo), id = entry(f.repo, wid, '可手删'), target = { kind: 'object' as const, id };
    service.action({ type: 'protection.set', target, enabled: true, expectedVersion: 0 });
    f.repo.execute(command(f.repo.read(), wid, [{ type: 'object.delete', id }]));
    assert.throws(() => service.action({ type: 'protection.set', target, enabled: false, expectedVersion: 0 }), { code: 'VERSION_CONFLICT' });
    const next = service.action({ type: 'protection.set', target, enabled: false, expectedVersion: 1 });
    assert.equal(next.protections[0]!.enabled, false); assert.equal(next.protections[0]!.version, 2);
    assert.throws(() => service.action({ type: 'protection.set', target, enabled: true, expectedVersion: 2 }), { code: 'MODEL_INVALID' });
    assert.throws(() => service.action({ type: 'protection.set', target: { kind: 'object', id: crypto.randomUUID() }, enabled: false, expectedVersion: 0 }), { code: 'MODEL_INVALID' });
  } finally { await service.stop(); await f.close(); }
});
