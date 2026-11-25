import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Store } from '../backend/server/store.ts';
import { WorkspaceRepository } from '../backend/server/workspace.ts';
import { Collaboration } from '../backend/server/collaboration.ts';
import { command, newWorld, titleOf } from '../client/wiki.ts';
import { operations, type AgentTaskStatus, type Policy } from '../contracts/collaboration.ts';

async function fixture(phase?: (id: string, phase: string) => Promise<void>, afterCommit = false) {
  const dir = await mkdtemp(path.join(tmpdir(), 'worldforge-collaboration-')); let store = new Store(dir);
  let fault = false;
  const makeRepository = () => new WorkspaceRepository(store.db, () => {}, stage => { if (afterCommit && fault && stage === 'afterCommit') { fault = false; throw new Error('模拟提交后中断'); } });
  let repo = makeRepository();
  const created = newWorld(repo.read(), '原世界', ''); repo.execute(created.command);
  let service = new Collaboration(store.db, repo, phase);
  const policy = (decision: 'allow' | 'ask' | 'deny'): Omit<Policy, 'version'> => ({ configured: true, initiative: 'respond', contribution: 'organize', permissions: Object.fromEntries(operations.map(o => [o, decision])) as Policy['permissions'] });
  function session(decision: 'allow' | 'ask' | 'deny' = 'allow') { const id = crypto.randomUUID(); service.action({ type: 'session.create', id, name: '会话' }); service.action({ type: 'policy.update', sessionId: id, expectedVersion: 0, policy: policy(decision) }); return id; }
  function enqueue(sessionId: string, title = '修改世界', revision = repo.read().revision) {
    const state = repo.read(), field = state.definitions.find(d => d.marks.includes('title'))!.id, id = crypto.randomUUID();
    service.action({ type: 'task.enqueue', id, sessionId, title, intent: 'change', reads: [], command: { ...command(state, created.worldId, [{ type: 'object.update', id: created.worldId, set: { [field]: [title] } }]), baseRevision: revision } }); return id;
  }
  async function wait(id: string, status: AgentTaskStatus) { for (let i = 0; i < 200; i++) { const task = service.task(id); if (task.status === status) return task; if (['failed', 'conflict'].includes(task.status) && status !== task.status) throw new Error(JSON.stringify(task)); await delay(10); } throw new Error(`Timeout ${status}: ${JSON.stringify(service.task(id))}`); }
  function control(type: string, id: string) { return service.action({ type, id, expectedVersion: service.task(id).version }); }
  return { get store() { return store; }, get repo() { return repo; }, get service() { return service; }, policy, session, enqueue, wait, control, wid: created.worldId, fault() { fault = true; }, async restart() { await service.stop(); store.close(); store = new Store(dir); repo = makeRepository(); service = new Collaboration(store.db, repo); }, async close() { await service.stop(); store.close(); await rm(dir, { recursive: true, maxRetries: 5, retryDelay: 50 }); } };
}
test('default policy is unconfirmed, sessions copy it independently and conflicting user settings are rejected', async () => {
  const f = await fixture(); try {
    assert.equal(f.service.read().defaults.configured, false);
    f.service.action({ type: 'policy.update', expectedVersion: 0, policy: f.policy('ask') });
    const a = f.session('allow'), b = f.session('deny');
    f.service.action({ type: 'policy.update', expectedVersion: 1, policy: f.policy('allow') });
    assert.equal(f.service.read().sessions.find(s => s.id === b)!.policy.permissions.modify, 'deny');
    assert.equal(f.service.read().sessions.find(s => s.id === a)!.policy.permissions.modify, 'allow');
    assert.throws(() => f.service.action({ type: 'policy.update', expectedVersion: 0, policy: f.policy('deny') }), /已有更新/);
  } finally { await f.close(); }
});
test('waiting task cannot bypass authorization by resume; approval applies only once and never changes session settings', async () => {
  const f = await fixture(); try {
    const s = f.session('ask'), id = f.enqueue(s), before = f.repo.read(); await f.wait(id, 'waiting');
    assert.throws(() => f.control('task.resume', id), /先明确授权/); await f.wait(id, 'waiting'); assert.deepEqual(f.repo.read(), before);
    f.control('task.approve', id); const completed = await f.wait(id, 'completed');
    assert.equal(f.repo.read().revision, before.revision + 1); assert(completed.receipt);
    const record = f.repo.history()[0]!; assert.equal(record.actor, 'agent'); assert.equal(record.taskId, id);
    assert.equal(f.service.read().sessions[0]!.policy.permissions.modify, 'ask');
    f.control('task.resume', id); assert.equal(f.repo.history().length, 2);
    const next = f.enqueue(s, '第二项'); await f.wait(next, 'waiting'); assert.equal(f.repo.history().length, 2);
    assert.throws(() => f.service.action({ type: 'task.enqueue', id: crypto.randomUUID(), sessionId: s, title: '越界', intent: 'read', reads: [], command: f.service.task(id).command }), /读取任务/);
    assert.throws(() => f.service.action({ type: 'task.enqueue', id: crypto.randomUUID(), sessionId: s, title: '自批', intent: 'read', reads: [], policy: f.policy('allow') }));
  } finally { await f.close(); }
});
test('Q22 running task retains original authorization while Q23 queued task starts with new permissions', async () => {
  let release!: () => void, started!: () => void; const began = new Promise<void>(r => { started = r; }), barrier = new Promise<void>(r => { release = r; }); let first = true;
  const f = await fixture(async (_id, phase) => { if (phase === 'started' && first) { first = false; started(); await barrier; } });
  try {
    const s = f.session(), rev = f.repo.read().revision, a = f.enqueue(s, '运行中的任务'), b = f.enqueue(s, '排队任务', rev + 1); await began;
    assert.equal(f.service.task(b).policy, undefined);
    f.service.action({ type: 'policy.update', sessionId: s, expectedVersion: 1, policy: { ...f.policy('allow'), permissions: { ...f.policy('allow').permissions, modify: 'deny' } } });
    release(); await f.wait(a, 'completed'); await f.wait(b, 'blocked');
    assert.equal(f.service.task(a).policy!.permissions.modify, 'allow'); assert.equal(f.service.task(b).policy!.permissions.modify, 'deny');
    assert.equal(titleOf(f.repo.read(), f.repo.read().objects.find(o => o.id === f.wid)!), '运行中的任务');
  } finally { release(); await f.close(); }
});
test('Q24 pause/resume and restart retain task identity and authorization without automatic execution', async () => {
  let release!: () => void, started!: () => void; const began = new Promise<void>(r => { started = r; }), barrier = new Promise<void>(r => { release = r; });
  const f = await fixture(async (_id, phase) => { if (phase === 'beforeApply') { started(); await barrier; } });
  try {
    const s = f.session(), id = f.enqueue(s); await began;
    f.control('task.pause', id); f.service.action({ type: 'policy.update', sessionId: s, expectedVersion: 1, policy: f.policy('deny') }); release(); await delay(50);
    assert.equal(f.service.task(id).status, 'paused'); assert.equal(f.repo.read().revision, 1);
    await f.restart(); assert.equal(f.repo.read().revision, 1); f.control('task.resume', id); await f.wait(id, 'completed');
    assert.equal(f.service.task(id).policy!.permissions.modify, 'allow'); assert.equal(f.repo.read().revision, 2);
    const waiting = f.enqueue(s, '被禁止的下一项'); await f.wait(waiting, 'blocked'); await f.restart();
    assert.equal(f.service.task(waiting).status, 'interrupted'); await delay(30); assert.equal(f.repo.read().revision, 2);
    f.control('task.resume', waiting); await f.wait(waiting, 'blocked');
  } finally { release(); await f.close(); }
});
test('cross-session content protection is rechecked at commit and task grants do not remove it', async () => {
  let release!: () => void, started!: () => void; const began = new Promise<void>(r => { started = r; }), barrier = new Promise<void>(r => { release = r; }); let first = true;
  const f = await fixture(async (_id, phase) => { if (phase === 'beforeApply' && first) { first = false; started(); await barrier; } });
  try {
    const s = f.session(), id = f.enqueue(s); await began;
    f.service.action({ type: 'protection.set', target: { kind: 'object', id: f.wid }, enabled: true, expectedVersion: 0 }); release(); await f.wait(id, 'waiting');
    assert.equal(f.repo.read().revision, 1); assert(f.service.task(id).needed.some(r => r.protection));
    assert.throws(() => f.control('task.resume', id), /先明确授权/); await f.wait(id, 'waiting'); assert.equal(f.repo.read().revision, 1);
    f.control('task.approve', id); await f.wait(id, 'completed'); assert.equal(f.service.read().protections[0]!.enabled, true);
    const second = f.enqueue(f.session(), '另一个会话'); await f.wait(second, 'waiting'); assert.equal(f.repo.read().revision, 2);
    // Manual editing is not an authorization grant to the Agent.
    const state = f.repo.read(), field = state.definitions.find(d => d.marks.includes('title'))!.id;
    f.repo.execute(command(state, f.wid, [{ type: 'object.update', id: f.wid, set: { [field]: ['用户手改'] } }]));
    assert.equal(f.repo.read().revision, 3);
  } finally { release(); await f.close(); }
});
test('independent sessions can proceed while one waits, and committed work reconciles once after an interrupted acknowledgement', async () => {
  const f = await fixture(undefined, true); try {
    const a = f.session('ask'), waiting = f.enqueue(a); await f.wait(waiting, 'waiting');
    const b = f.session(), id = f.enqueue(b, '独立任务'); f.fault(); await f.wait(id, 'interrupted');
    const revision = f.repo.read().revision; assert.equal(revision, 2); await f.restart();
    assert.equal(f.service.task(waiting).status, 'interrupted'); f.control('task.resume', id); await f.wait(id, 'completed');
    assert.equal(f.repo.read().revision, revision); assert.equal(f.repo.history().filter(h => h.taskId === id).length, 1);
  } finally { await f.close(); }
});

test('field and file protection cover definition changes and resource writes, not only direct object editing', async () => {
  const f = await fixture(); try {
    const s = f.session(), state = f.repo.read(), field = state.definitions.find(d => d.marks.includes('title'))!;
    f.service.action({ type: 'protection.set', target: { kind: 'field', id: field.id, objectId: f.wid }, enabled: true, expectedVersion: 0 });
    const { version: _v, ...definition } = field;
    const id = crypto.randomUUID();
    f.service.action({ type: 'task.enqueue', id, sessionId: s, title: '改字段定义', intent: 'change', reads: [], command: command(state, f.wid, [{ type: 'definition.put', definition: { ...definition, name: '称呼' } }]) });
    await f.wait(id, 'waiting'); assert(f.service.task(id).needed.some(r => r.target?.kind === 'field'));
    f.control('task.cancel', id);
    const resource = state.resources[0]!, version = state.resourceVersions.find(v => v.id === resource.id)!;
    f.service.action({ type: 'protection.set', target: { kind: 'resource', id: resource.id }, enabled: true, expectedVersion: 0 });
    const fileTask = crypto.randomUUID();
    f.service.action({ type: 'task.enqueue', id: fileTask, sessionId: s, title: '改文件', intent: 'change', reads: [], command: command(state, f.wid, [{ type: 'resource.put', id: resource.id, worldId: f.wid, path: '资料/改名.md', content: version.content, mime: version.mime }]) });
    await f.wait(fileTask, 'waiting'); assert.deepEqual(f.repo.read(), state); assert(f.service.task(fileTask).needed.some(r => r.target?.kind === 'resource'));
  } finally { await f.close(); }
});
test('authorized reading returns only explicit targets and completed reads do not become unlimited future access', async () => {
  const f = await fixture(); try {
    const s = f.session('ask'), state = f.repo.read(), field = state.definitions.find(d => d.marks.includes('title'))!.id, id = crypto.randomUUID();
    f.service.action({ type: 'task.enqueue', id, sessionId: s, title: '只读一个名称', intent: 'read', reads: [{ kind: 'field', id: field, objectId: f.wid }] });
    await f.wait(id, 'waiting'); assert.throws(() => f.service.authorizedRead(id), /尚未授权/);
    f.control('task.approve', id); await f.wait(id, 'completed');
    assert.deepEqual(f.service.authorizedRead(id), [{ target: { kind: 'field', id: field, objectId: f.wid }, value: ['原世界'] }]);
    f.repo.execute(command(state, f.wid, [{ type: 'object.update', id: f.wid, set: { [field]: ['后来内容'] } }]));
    assert.deepEqual(f.service.authorizedRead(id)[0]!.value, ['原世界']);
    await f.restart(); assert.deepEqual(f.service.authorizedRead(id)[0]!.value, ['原世界']);
  } finally { await f.close(); }
});
