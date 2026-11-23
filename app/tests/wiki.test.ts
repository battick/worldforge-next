import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Store } from '../backend/server/store.ts';
import { WorkspaceRepository } from '../backend/server/workspace.ts';
import { bodyRefs, command, confirmWorld, encodeBytes, encodeText, isFolder, kindOf, locationsOf, moveResources, newObject, newWorld, relocate, resourceText, saveBody, searchObjects, titleOf, worldStatus } from '../client/wiki.ts';

async function fixture() {
  const dir = await mkdtemp(path.join(tmpdir(), 'worldforge-wiki-'));
  let store = new Store(dir), repo = new WorkspaceRepository(store.db);
  return { dir, get repo() { return repo; }, restart() { store.close(); store = new Store(dir); repo = new WorkspaceRepository(store.db); }, async close() { store.close(); await rm(dir, { recursive: true }); } };
}
test('manual worlds start blank, retain source bytes and can be confirmed and reopened', async () => {
  const f = await fixture();
  try {
    const blank = newWorld(f.repo.read(), '', ''); f.repo.execute(blank.command);
    let state = f.repo.read(); assert.equal(worldStatus(state, state.objects[0]!), 'draft');
    assert.equal(titleOf(state, state.objects[0]!), '未命名世界');
    const source = '# 原始资料\n这仍然只是参考。';
    const created = newWorld(state, '雾海', '只有一个想法', { name: '参考.md', mime: 'text/markdown', content: encodeText(source) }); f.repo.execute(created.command);
    state = f.repo.read();
    assert.equal(state.objects.filter(o => o.worldId === created.worldId).length, 1);
    const original = state.resources.find(r => r.worldId === created.worldId && r.path === '资料/参考.md')!;
    assert.equal(resourceText(state, original.id, 1), source);
    f.repo.execute(confirmWorld(state, created.worldId)); f.restart(); state = f.repo.read();
    assert.equal(worldStatus(state, state.objects.find(o => o.id === created.worldId)!), 'created');
    assert.equal(state.resources.find(r => r.id === original.id)!.version, 1);
    assert(state.definitions.filter(d => !d.system).every(d => d.scope !== 'global'));
    assert.equal(state.objects.length, 2);
  } finally { await f.close(); }
});
test('formal body saves are atomic, retry once and preserve stable links through resource moves', async () => {
  const f = await fixture();
  try {
    const world = newWorld(f.repo.read(), '笔记', ''); f.repo.execute(world.command);
    const entry = newObject(f.repo.read(), world.worldId, '灯塔', 'entry'); f.repo.execute(entry.command);
    let state = f.repo.read(), object = state.objects.find(o => o.id === entry.id)!;
    let ref = bodyRefs(state, object)[0]!;
    const saved = saveBody(state, object, '# 灯塔\n\n[[missing-id|失踪的港口]]', ref.fieldId, ref.resource);
    const receipt = f.repo.execute(saved); assert.deepEqual(f.repo.execute(saved), receipt);
    assert.equal(f.repo.history().filter(h => h.operationId === saved.operationId).length, 1);
    state = f.repo.read(); object = state.objects.find(o => o.id === entry.id)!; ref = bodyRefs(state, object)[0]!;
    assert.equal(ref.version, 2); assert.equal(resourceText(state, ref.resource, 2), '# 灯塔\n\n[[missing-id|失踪的港口]]');
    assert.throws(() => f.repo.execute({ ...saved, operationId: crypto.randomUUID() }), /资料已改变/);
    const resource = state.resources.find(r => r.id === ref.resource)!;
    f.repo.execute(moveResources(state, world.worldId, resource.path, '资料/世界/灯塔.md'));
    state = f.repo.read(); object = state.objects.find(o => o.id === entry.id)!;
    f.repo.execute(saveBody(state, object, '移动后仍可编辑', ref.fieldId, ref.resource));
    state = f.repo.read(); object = state.objects.find(o => o.id === entry.id)!;
    const after = bodyRefs(state, object)[0]!;
    assert.equal(after.resource, ref.resource); assert.equal(after.version, 4);
    assert.equal(state.resources.find(r => r.id === ref.resource)!.path, '资料/世界/灯塔.md');
    assert.equal(resourceText(state, ref.resource, 2), '# 灯塔\n\n[[missing-id|失踪的港口]]');
    assert.equal(state.objects.length, 2); // A missing link never creates an entry.
  } finally { await f.close(); }
});
test('navigation is ordinary object fields; one position can move or disappear without copying content', async () => {
  const f = await fixture();
  try {
    const world = newWorld(f.repo.read(), '目录', ''); f.repo.execute(world.command);
    const a = newObject(f.repo.read(), world.worldId, '人物', 'entry', [], [], true); f.repo.execute(a.command);
    const b = newObject(f.repo.read(), world.worldId, '历史', 'entry', [], [], true); f.repo.execute(b.command);
    const item = newObject(f.repo.read(), world.worldId, '守塔人', 'entry', [], [], false, a.id); f.repo.execute(item.command);
    let state = f.repo.read(), object = state.objects.find(o => o.id === item.id)!;
    assert(isFolder(state, state.objects.find(o => o.id === a.id)!));
    assert.deepEqual(Object.keys(state.objects.find(o => o.id === a.id)!).sort(), ['fields', 'id', 'worldId']);
    assert.equal(kindOf(state.objects.find(o => o.id === a.id)!), 'entry');
    f.repo.execute(relocate(state, object, b.id, undefined, true));
    state = f.repo.read(); object = state.objects.find(o => o.id === item.id)!;
    assert.deepEqual(new Set(locationsOf(state, object)), new Set([a.id, b.id]));
    const body = bodyRefs(state, object)[0]!;
    f.repo.execute(relocate(state, object, '', a.id));
    state = f.repo.read(); object = state.objects.find(o => o.id === item.id)!;
    assert.deepEqual(locationsOf(state, object), [b.id]); assert.equal(bodyRefs(state, object)[0]!.resource, body.resource);
    assert.equal(searchObjects(state, world.worldId, '守塔人').filter(hit => hit.object.id === item.id).length, 1);
    const before = f.repo.read();
    assert.throws(() => f.repo.execute(command(before, world.worldId, [{ type: 'object.delete', id: b.id }])), /引用对象不存在/);
    assert.deepEqual(f.repo.read(), before);
    f.repo.execute(relocate(state, object, '', b.id));
    state = f.repo.read(); assert.deepEqual(locationsOf(state, state.objects.find(o => o.id === item.id)!), []);
    assert.equal(state.objects.filter(o => o.id === item.id).length, 1);
  } finally { await f.close(); }
});
test('relations retain every endpoint, can reference relations and have no preset body', async () => {
  const f = await fixture();
  try {
    const world = newWorld(f.repo.read(), '关系', ''); f.repo.execute(world.command);
    const first = newObject(f.repo.read(), world.worldId, '人物', 'entry'); f.repo.execute(first.command);
    const second = newObject(f.repo.read(), world.worldId, '地点', 'entry'); f.repo.execute(second.command);
    const relation = newObject(f.repo.read(), world.worldId, '驻守', 'relation', [world.worldId, first.id], [second.id]); f.repo.execute(relation.command);
    const other = newObject(f.repo.read(), world.worldId, '援助', 'relation', [first.id], [relation.id]); f.repo.execute(other.command);
    const state = f.repo.read(); assert.equal(state.objects.filter(o => kindOf(o) === 'relation').length, 2);
    assert.deepEqual(bodyRefs(state, state.objects.find(o => o.id === relation.id)!), []);
    assert.equal(f.repo.references().filter(r => r.ownerId === relation.id).length, 3);
    assert(f.repo.references().some(r => r.ownerId === other.id && r.targetId === relation.id));
  } finally { await f.close(); }
});
test('space import, nested move and copy keep originals, bytes and transactional conflicts', async () => {
  const f = await fixture();
  try {
    const world = newWorld(f.repo.read(), '资料', ''); f.repo.execute(world.command);
    const file = crypto.randomUUID(), binary = crypto.randomUUID();
    const text = '第一段参考\n不会自动成为正式设定';
    f.repo.execute(command(f.repo.read(), world.worldId, [
      { type: 'resource.put', id: file, worldId: world.worldId, path: '资料/人物/背景.txt', mime: 'text/plain', content: encodeText(text) },
      { type: 'resource.put', id: binary, worldId: world.worldId, path: '资料/人物/扫描.pdf', mime: 'application/pdf', content: encodeBytes(new Uint8Array([0, 255, 3, 4])) },
    ]));
    f.repo.execute(moveResources(f.repo.read(), world.worldId, '资料/人物', '副本/人物', true));
    let state = f.repo.read(); assert.equal(state.resources.length, 5); assert.equal(state.objects.length, 1);
    assert.equal(resourceText(state, file, 1), text);
    assert.equal(state.resourceVersions.find(v => v.id === binary)!.content, 'AP8DBA==');
    const before = f.repo.read();
    assert.throws(() => f.repo.execute(moveResources(before, world.worldId, '资料/人物', '副本/人物')), /逻辑路径重复/);
    assert.deepEqual(f.repo.read(), before);
    f.repo.execute(moveResources(before, world.worldId, '资料/人物', '旧资料/人物')); f.restart(); state = f.repo.read();
    assert.equal(state.resources.find(r => r.id === file)!.path, '旧资料/人物/背景.txt');
    assert.equal(resourceText(state, file, 1), text); assert.equal(resourceText(state, file, 2), text);
    assert(state.resources.some(r => r.id !== file && r.path === '副本/人物/背景.txt'));
  } finally { await f.close(); }
});
