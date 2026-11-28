import { Annotation, Command, END, START, StateGraph, interrupt } from '@langchain/langgraph';
import { SqliteSaver } from '@langchain/langgraph-checkpoint-sqlite';
import { EventEmitter } from 'node:events';
import { ZodError } from 'zod';
import type Database from 'better-sqlite3';
import { AppError } from '../core/errors.ts';
import { canonical } from '../core/model.ts';
import { agentActionSchema, initialPolicy, missingPermissions, requirements, targetKey } from '../core/authorization.ts';
import type { AgentAction, AgentTask, CollaborationView, Policy, Protection, Session, Target } from '../../contracts/collaboration.ts';
import { WorkspaceRepository } from './workspace.ts';

const GraphState = Annotation.Root({ id: Annotation<string>() });
const terminal = new Set(['completed', 'cancelled', 'conflict', 'failed']);
function fail(code: string, message: string, status = 409): never { throw new AppError(code, message, status); }
export class Collaboration {
  readonly events = new EventEmitter();
  private graph;
  private active = new Map<string, Promise<void>>();
  private closing = false;
  constructor(private db: Database.Database, private workspace: WorkspaceRepository, private onPhase?: (id: string, phase: string) => Promise<void>) {
    db.transaction(() => {
      db.exec(`CREATE TABLE IF NOT EXISTS agent_meta(id INTEGER PRIMARY KEY CHECK(id=1), eventId INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS agent_policies(id TEXT PRIMARY KEY, data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS agent_sessions(id TEXT PRIMARY KEY, data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS agent_protections(id TEXT PRIMARY KEY, data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS agent_tasks(id TEXT PRIMARY KEY, data TEXT NOT NULL);
        INSERT OR IGNORE INTO agent_meta VALUES(1,0);`);
      for (const task of this.tasks()) if ((!terminal.has(task.status) || task.status === 'failed' && task.retryable !== false) && task.status !== 'paused') this.putTask(task.id, { status: 'interrupted', step: '进度已保存，点击继续后恢复原任务' });
    })();
    this.graph = new StateGraph(GraphState)
      .addNode('start', async ({ id }) => {
        const task = this.task(id);
        if (!task.policy) this.putTask(id, { policy: this.session(task.sessionId).policy });
        this.putTask(id, { step: '核对原任务范围与适用授权' }); await this.onPhase?.(id, 'started'); return {};
      })
      .addNode('authorize', async ({ id }) => { await this.gate(id); return {}; })
      .addNode('apply', async ({ id }) => {
        await this.onPhase?.(id, 'beforeApply');
        const task = this.task(id);
        const prior = this.workspace.history().find(h => h.operationId === task.command?.operationId);
        if (prior?.actor === 'agent' && prior.taskId === id) { this.putTask(id, { receipt: { operationId: prior.operationId, revision: prior.revision } }); return {}; }
        await this.gate(id);
        if (task.command) {
          // No awaits between the final gate and synchronous atomic commit.
          const receipt = this.workspace.commit(this.workspace.prepare(task.command, { actor: 'agent', taskId: id }));
          this.putTask(id, { receipt, step: '正式修改已整体保存' });
        } else this.putTask(id, { step: '读取范围已获授权', result: this.authorizedRead(id) });
        return {};
      }).addEdge(START, 'start').addEdge('start', 'authorize').addEdge('authorize', 'apply').addEdge('apply', END)
      .compile({ checkpointer: new SqliteSaver(db) });
  }
  private rows<T>(table: string): T[] { return (this.db.prepare(`SELECT data FROM ${table} ORDER BY rowid`).all() as { data: string }[]).map(r => JSON.parse(r.data)); }
  private save(table: string, id: string, value: unknown) { this.db.prepare(`INSERT INTO ${table} VALUES (?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data`).run(id, JSON.stringify(value)); }
  private changed() { this.db.prepare('UPDATE agent_meta SET eventId=eventId+1 WHERE id=1').run(); this.events.emit('change'); }
  tasks() { return this.rows<AgentTask>('agent_tasks'); }
  task(id: string) { const task = this.tasks().find(t => t.id === id); if (!task) fail('NOT_FOUND', '未找到这个任务。', 404); return task; }
  private session(id: string) { const session = this.rows<Session>('agent_sessions').find(s => s.id === id); if (!session) fail('NOT_FOUND', '未找到这个会话。', 404); return session; }
  private putTask(id: string, patch: Partial<AgentTask>) { const task = this.task(id); this.save('agent_tasks', id, { ...task, ...patch, version: task.version + 1, updatedAt: new Date().toISOString() }); this.changed(); }
  read(): CollaborationView {
    return this.db.transaction(() => ({ eventId: (this.db.prepare('SELECT eventId FROM agent_meta WHERE id=1').get() as { eventId: number }).eventId,
      defaults: this.rows<Policy>('agent_policies')[0] ?? initialPolicy(), sessions: this.rows<Session>('agent_sessions'), protections: this.rows<Protection>('agent_protections'), tasks: this.tasks() }))();
  }
  private targetExists(target: Target) {
    const state = this.workspace.read();
    const found = target.kind === 'object' ? state.objects.some(o => o.id === target.id) : target.kind === 'resource' ? state.resources.some(r => r.id === target.id) : state.definitions.some(d => d.id === target.id);
    if (!found || target.objectId && !state.objects.some(o => o.id === target.objectId)) fail('MODEL_INVALID', '授权目标不存在。', 422);
  }
  action(input: unknown): CollaborationView {
    const action = agentActionSchema.parse(input) as AgentAction;
    this.db.transaction(() => {
      switch (action.type) {
        case 'policy.update': {
          const current = action.sessionId ? this.session(action.sessionId).policy : this.read().defaults;
          if (current.version !== action.expectedVersion) fail('VERSION_CONFLICT', '协作设置已有更新，请重新读取。');
          const policy = { ...action.policy, version: current.version + 1 };
          if (action.sessionId) this.save('agent_sessions', action.sessionId, { ...this.session(action.sessionId), policy });
          else this.save('agent_policies', 'default', policy); break;
        }
        case 'session.create': {
          const existing = this.read().sessions.find(s => s.id === action.id);
          if (existing) { if (existing.name !== action.name) fail('OPERATION_CONFLICT', '会话编号已用于其他会话。'); return; }
          this.save('agent_sessions', action.id, { id: action.id, name: action.name, policy: { ...this.read().defaults, version: 0 } }); break;
        }
        case 'protection.set': {
          const key = targetKey(action.target), previous = this.read().protections.find(p => p.key === key);
          if ((previous?.version ?? 0) !== action.expectedVersion) fail('VERSION_CONFLICT', '内容保护已有更新，请重新读取。');
          if (action.enabled || !previous) this.targetExists(action.target);
          this.save('agent_protections', key, { key, target: action.target, enabled: action.enabled, version: action.expectedVersion + 1 }); break;
        }
        case 'task.enqueue': {
          if (action.intent === 'read' && action.command || action.intent === 'change' && !action.command) fail('MODEL_INVALID', '检查/读取任务不能携带修改，修改任务必须有明确命令。', 422);
          this.session(action.sessionId); for (const target of action.reads) this.targetExists(target);
          const existing = this.tasks().find(t => t.id === action.id);
          if (existing) { const plan = (t: typeof action | AgentTask) => ({ id: t.id, sessionId: t.sessionId, title: t.title, intent: t.intent, reads: t.reads, command: t.command }); if (canonical(plan(existing)) !== canonical(plan(action))) fail('OPERATION_CONFLICT', '任务编号已用于另一份任务内容。'); return; }
          const now = new Date().toISOString();
          const { type: _type, ...plan } = action;
          this.save('agent_tasks', action.id, { ...plan, status: 'queued', step: '等待同会话前序任务', version: 1, grants: [], needed: [], createdAt: now, updatedAt: now }); break;
        }
        default: {
          const task = this.task(action.id);
          if (task.version !== action.expectedVersion) fail('VERSION_CONFLICT', '任务状态已改变，请重新读取。');
          if (['completed', 'cancelled'].includes(task.status)) return;
          if (action.type === 'task.cancel') { this.putTask(task.id, { status: 'cancelled', step: '任务已取消，已有成果未回滚' }); break; }
          if (action.type === 'task.pause') {
            if (!['running', 'queued', 'waiting', 'blocked', 'paused', 'interrupted'].includes(task.status)) fail('TASK_STATE', '失败或冲突任务不能通过暂停改变恢复条件。');
            this.putTask(task.id, { status: 'paused', step: '用户已暂停，已保存成果保留' });
          }
          if (action.type === 'task.resume') {
            if (!['paused', 'interrupted'].includes(task.status) && !(task.status === 'failed' && task.retryable !== false)) fail('TASK_STATE', '只有暂停、中断或可重试失败任务可以继续；等待授权的任务须先明确授权，冲突或无效方案须重新准备。');
            this.putTask(task.id, { status: 'queued', step: '用户已请求继续原任务', error: undefined, retryable: undefined });
          }
          if (action.type === 'task.approve') {
            if (!['waiting', 'blocked'].includes(task.status) || !task.needed.length) fail('TASK_STATE', '当前任务没有等待这项授权。');
            this.putTask(task.id, { grants: [...new Set([...task.grants, ...task.needed.map(r => r.key)])], needed: [], status: 'queued', step: '仅授权本任务的已列明范围' });
          }
        }
      }
      this.changed();
    })();
    void this.pump(); return this.read();
  }
  private async gate(id: string) {
    const check = () => {
      const task = this.task(id), before = this.workspace.read();
      const prepared = task.command ? this.workspace.prepare(task.command, { actor: 'agent', taskId: id }) : undefined;
      const all = requirements(task, prepared && 'state' in prepared ? prepared.changes : [], before, prepared && 'state' in prepared ? prepared.state : before);
      const needed = missingPermissions(task, all, this.read().protections);
      if (needed.length) this.putTask(id, { status: needed.some(r => task.policy?.permissions[r.operation] === 'deny' && !r.protection) ? 'blocked' : 'waiting', needed, step: '尚未应用，等待用户决定授权范围' });
      return needed;
    };
    if (this.closing || ['paused', 'cancelled'].includes(this.task(id).status)) {
      interrupt({ reason: '执行已暂停或关闭' });
      if (this.closing || ['paused', 'cancelled'].includes(this.task(id).status)) fail('TASK_HOLD', '任务仍处于暂停状态。');
    }
    if (check().length) {
      interrupt({ reason: '授权不足' });
      if (check().length) fail('PERMISSION_REQUIRED', '仍未获得本任务所需授权。', 403);
    }
  }
  private async pump() {
    if (this.closing) return;
    for (const session of this.read().sessions) {
      if (this.active.has(session.id)) continue;
      const task = this.tasks().find(t => t.sessionId === session.id && !terminal.has(t.status));
      if (!task || task.status !== 'queued') continue;
      this.putTask(task.id, { policy: task.policy ?? session.policy, status: 'running', step: task.policy ? '继续原任务与原授权' : '开始并保存当前会话授权' });
      const run = this.run(task.id).finally(() => { this.active.delete(session.id); if (!this.closing) void this.pump(); }); this.active.set(session.id, run);
    }
  }
  private async run(id: string) {
    try {
      const config = { configurable: { thread_id: `agent-task:${id}` } }, saved = await this.graph.getState(config);
      const task = this.task(id);
      const prior = this.workspace.history().find(h => h.operationId === task.command?.operationId && h.actor === 'agent' && h.taskId === id);
      if (prior) { this.putTask(id, { status: 'completed', step: '核对已提交成果，未重复写入', receipt: { operationId: prior.operationId, revision: prior.revision } }); return; }
      await this.graph.invoke(!saved.createdAt || !saved.next.length ? { id } : saved.tasks.some(t => t.interrupts?.length) ? new Command({ resume: true }) : null, config);
      const result = await this.graph.getState(config), latest = this.task(id);
      if (!result.next.length && !result.tasks.some(t => t.interrupts?.length) && (latest.receipt || latest.result) && !['cancelled', 'paused', 'waiting', 'blocked'].includes(latest.status)) this.putTask(id, { status: 'completed', step: latest.receipt ? '任务已完成，正式修改已保存' : '读取任务已完成', needed: [] });
    } catch (e) {
      const task = this.task(id);
      if (e instanceof AppError && e.code === 'PERMISSION_REQUIRED') return;
      if (task.status === 'paused' || task.status === 'cancelled') return;
      const committed = this.workspace.history().find(h => h.operationId === task.command?.operationId && h.actor === 'agent' && h.taskId === id);
      if (committed) { this.putTask(id, { status: 'interrupted', step: '保存结果待核对，点击继续原任务', error: '正式修改可能已经生效，继续时只核对原操作。' }); return; }
      const conflict = e instanceof AppError && e.code === 'VERSION_CONFLICT';
      const retryable = !(e instanceof ZodError) && !(e instanceof AppError && e.status < 500);
      this.putTask(id, { status: this.closing ? 'interrupted' : conflict ? 'conflict' : 'failed', retryable: !conflict && retryable,
        step: this.closing ? '进度已保存，点击继续' : conflict || !retryable ? '尚未应用，请核对资料并重新准备方案' : '执行遇到故障，排除原因后可继续原任务', error: e instanceof Error ? e.message : '执行失败' });
    }
  }
  /** The future model tool receives only these explicit targets, never a complete workspace snapshot. */
  authorizedRead(id: string) {
    const task = this.task(id), state = this.workspace.read();
    if (task.status === 'completed') return task.result ?? [];
    if (task.status !== 'running' || !task.policy || missingPermissions(task, requirements({ ...task, command: undefined }, [], state, state), []).length) fail('PERMISSION_REQUIRED', '尚未授权本任务的读取范围。', 403);
    return task.reads.map(target => { this.targetExists(target); return { target, value: target.kind === 'object' ? state.objects.find(o => o.id === target.id) : target.kind === 'field' ? (target.objectId ? state.objects.find(o => o.id === target.objectId)?.fields[target.id] : state.objects.filter(o => target.id in o.fields).map(o => ({ id: o.id, values: o.fields[target.id] }))) : target.kind === 'definition' ? state.definitions.find(d => d.id === target.id) : state.resourceVersions.find(v => v.id === target.id && v.version === state.resources.find(r => r.id === target.id)?.version) }; });
  }
  async stop() { this.closing = true; await Promise.allSettled(this.active.values()); for (const task of this.tasks()) if (!terminal.has(task.status) && task.status !== 'paused') this.putTask(task.id, { status: 'interrupted', step: '进度已保存，点击继续原任务' }); }
}
