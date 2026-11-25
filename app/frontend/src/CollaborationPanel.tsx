import { forwardRef, useEffect, useRef, useState } from 'react';
import { operations, type AgentAction, type CollaborationView, type Policy, type Target } from '../../contracts/collaboration.ts';
import type { Change, WorkspaceState } from '../../contracts/workspace.ts';
import { api } from './api.ts';
import { titleOf } from '../../client/wiki.ts';
import { useDirtyGuard, type DirtyHandle } from './hooks/useDirtyGuard.ts';

const labels = { read: '读取', create: '创建', modify: '修改', delete: '删除', save: '保存', apply: '应用成果' };
const statuses = { queued: '排队中', running: '执行中', waiting: '等待授权', blocked: '权限禁止', paused: '已暂停', interrupted: '等待继续', conflict: '资料有冲突', failed: '执行失败', completed: '已完成', cancelled: '已取消' };
export function CollaborationPanel({ onClose }: { onClose(): void }) {
  const [view, setView] = useState<CollaborationView>(), [workspace, setWorkspace] = useState<WorkspaceState>(), [scope, setScope] = useState('');
  const [name, setName] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false), [notice, setNotice] = useState('');
  const [kind, setKind] = useState<Target['kind']>('object'), [targetId, setTargetId] = useState(''), [objectId, setObjectId] = useState('');
  const form = useRef<DirtyHandle>(null), pendingSession = useRef<string | undefined>(undefined);
  useDirtyGuard(undefined, () => Boolean(name || busy || form.current?.dirty()));
  useEffect(() => { api.collaboration().then(setView).catch(e => setError(e.message)); api.workspace().then(v => setWorkspace(v.state)).catch(e => setError(e.message)); return api.subscribeCollaboration(setView); }, []);
  const run = async (action: AgentAction) => { setBusy(true); setError(''); setNotice(''); try { const next = await api.agentAction(action); setView(next); return next; } catch (e) { setError((e as Error).message); return undefined; } finally { setBusy(false); } };
  const targetName = (target: Target) => {
    if (!workspace) return '正在读取名称';
    const object = workspace.objects.find(o => o.id === (target.objectId ?? target.id));
    return target.kind === 'object' ? object ? titleOf(workspace, object) : '已移除条目' : target.kind === 'resource' ? workspace.resources.find(r => r.id === target.id)?.path ?? '已移除文件' : `${target.objectId ? `${object ? titleOf(workspace, object) : '条目'} · ` : ''}${workspace.definitions.find(d => d.id === target.id)?.name ?? '已移除字段'}`;
  };
  const describeChange = (change: Change): string => {
    if (change.type === 'definition.put') return `设置字段“${change.definition.name}”，其规则与关联资料会整体校验`;
    if (change.type === 'definition.delete') return `删除字段定义 · ${targetName({ kind: 'definition', id: change.id })}`;
    if (change.type === 'resource.put') {
      let preview = ''; try { if (change.mime.startsWith('text/')) preview = new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(atob(change.content), c => c.charCodeAt(0))); } catch {}
      return `保存文件 · ${change.path}${preview ? `\n${preview.slice(0, 1000)}${preview.length > 1000 ? '…（仅显示前1000字）' : ''}` : ''}`;
    }
    if (change.type === 'resource.delete') return `删除文件 · ${targetName({ kind: 'resource', id: change.id })}`;
    if (change.type === 'object.delete') return `删除条目内容 · ${targetName({ kind: 'object', id: change.id })}`;
    if (change.type === 'world.create') return '创建新世界';
    const values = change.type === 'object.create' ? change.fields : change.set ?? {};
    return `${change.type === 'object.create' ? '创建内容' : `修改 · ${targetName({ kind: 'object', id: change.id })}`}\n${Object.entries(values).map(([id, values]) => `${workspace?.definitions.find(d => d.id === id)?.name ?? '新字段'}：${values.map(v => typeof v === 'string' ? v : JSON.stringify(v)).join('、') || '空值'}`).join('\n')}${change.type === 'object.update' && change.unset?.length ? `\n移除字段：${change.unset.map(id => workspace?.definitions.find(d => d.id === id)?.name ?? '字段').join('、')}` : ''}`;
  };
  return <section className="collaboration-panel" aria-label="协作设置与任务"><div className="collaboration-heading"><h2>协作设置与任务</h2><button onClick={() => { if (!name && !form.current?.dirty() || window.confirm('有未保存的协作设置，确定关闭吗？')) onClose(); }}>关闭协作面板</button></div>
    <p>先配置默认协作方式，新会话会采用它。当前会话可单独调整；已开始任务保留原授权，排队任务开始时再采用设置。真实模型和自动共创尚未接入，演示聊天仍不会修改世界。</p>
    {error && <p role="alert" className="inline-error">{error} 输入保留；若保存结果不确定，请重新读取核对。</p>}{notice && <p role="status">{notice}</p>}
    {!view ? <p>正在读取协作设置…</p> : <>
      <label>设置范围<select aria-label="协作设置范围" value={scope} onChange={e => { if (!form.current?.dirty() || window.confirm('设置尚未保存，确定放弃并切换范围吗？')) setScope(e.target.value); }}><option value="">新会话默认设置</option>{view.sessions.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
      <PolicyForm ref={form} key={scope} policy={scope ? view.sessions.find(s => s.id === scope)!.policy : view.defaults} busy={busy} save={async (policy, expectedVersion) => { const result = await run({ type: 'policy.update', ...(scope ? { sessionId: scope } : {}), policy, expectedVersion }); if (result) { setNotice('协作设置已保存，不会改变已开始任务的授权'); return scope ? result.sessions.find(s => s.id === scope)!.policy : result.defaults; } }} />
      <div className="collaboration-session"><label>新会话名称<input aria-label="新协作会话名称" value={name} onChange={e => { setName(e.target.value); pendingSession.current = undefined; }} /></label><button disabled={busy || !name.trim()} onClick={async () => { const id = pendingSession.current ?? crypto.randomUUID(); pendingSession.current = id; const next = await run({ type: 'session.create', id, name: name.trim() }); if (next) { setName(''); pendingSession.current = undefined; setScope(id); } }}>新建协作会话</button></div>
      <h3>内容保护</h3><p>保护跨会话生效。它要求明确授权后才允许修改，不限制你亲自编辑或读取。授权本任务不会取消内容保护。</p>
      {workspace && <div className="collaboration-protection"><label>保护范围<select aria-label="保护范围" value={kind} onChange={e => { setKind(e.target.value as Target['kind']); setTargetId(''); setObjectId(''); }}><option value="object">单条目</option><option value="field">字段值</option><option value="definition">字段定义及其值</option><option value="resource">单文件</option></select></label>
        <label>保护内容<select aria-label="保护内容" value={targetId} onChange={e => setTargetId(e.target.value)}><option value="">请选择</option>{kind === 'object' ? workspace.objects.map(o => <option key={o.id} value={o.id}>{titleOf(workspace, o)} · {o.id.slice(0, 8)}</option>) : kind === 'resource' ? workspace.resources.map(r => <option key={r.id} value={r.id}>{r.path} · {r.id.slice(0, 8)}</option>) : workspace.definitions.filter(d => !d.system).map(d => <option key={d.id} value={d.id}>{d.name} · {d.id.slice(0, 8)}</option>)}</select></label>
        {kind === 'field' && <label>字段所在条目<select aria-label="字段所在条目" value={objectId} onChange={e => setObjectId(e.target.value)}><option value="">所有采用此字段的条目</option>{workspace.objects.map(o => <option key={o.id} value={o.id}>{titleOf(workspace, o)} · {o.id.slice(0, 8)}</option>)}</select></label>}
        <button disabled={busy || !targetId} onClick={async () => { const target: Target = { kind, id: targetId, ...(objectId ? { objectId } : {}) }; const old = view.protections.find(p => JSON.stringify(p.target) === JSON.stringify(target)); if (await run({ type: 'protection.set', target, enabled: true, expectedVersion: old?.version ?? 0 })) setNotice('内容保护已保存'); }}>保护所选内容</button>
      </div>}
      <ul className="collaboration-protections">{view.protections.filter(p => p.enabled).map(p => <li key={p.key}><span>{targetName(p.target)}</span><button disabled={busy} onClick={() => run({ type: 'protection.set', target: p.target, enabled: false, expectedVersion: p.version })}>取消保护</button></li>)}</ul>
      <h3>任务与已保存进度</h3><p>这里只列真实准备任务，与创作纸演示任务分开。暂停不会撤销已保存修改；回滚执行将在后续阶段接入。</p>
      {!view.tasks.length && <p>当前没有准备任务。真实模型接入后将沿用这里的授权和任务入口。</p>}
      {view.tasks.filter(t => !scope || t.sessionId === scope).map(task => <article className="collaboration-task" key={task.id}><h4>{task.title} · {statuses[task.status]}</h4><p>{task.step}</p>{task.error && <p role="alert">{task.error}</p>}<small>{task.policy ? '已保存本任务适用的授权' : '尚未开始，开始时采用会话设置'}</small>
        <details open={task.needed.length > 0}><summary>任务范围</summary><p>{task.intent === 'read' ? '只读资料，不含修改命令' : `整体修改${task.command?.changes.length ?? 0}项，不会只应用其中一半`}</p>{task.reads.map((t, i) => <p key={i}>读取 · {targetName(t)}</p>)}{task.command?.changes.map((change, i) => <pre className="collaboration-preview" key={i}>{describeChange(change)}</pre>)}</details>
        {task.needed.length > 0 && <ul>{task.needed.map(r => <li key={r.key}>{labels[r.operation]}{r.target ? ` · ${targetName(r.target)}` : ''}：{r.reason}</li>)}</ul>}
        {['waiting', 'blocked'].includes(task.status) && <button disabled={busy} onClick={() => run({ type: 'task.approve', id: task.id, expectedVersion: task.version })}>仅授权本任务列出的操作</button>}
        {['running', 'queued', 'waiting', 'blocked'].includes(task.status) && <button disabled={busy} onClick={() => run({ type: 'task.pause', id: task.id, expectedVersion: task.version })}>暂停任务</button>}
        {['paused', 'interrupted'].includes(task.status) && <button disabled={busy} onClick={() => run({ type: 'task.resume', id: task.id, expectedVersion: task.version })}>继续原任务</button>}
        {!['completed', 'cancelled'].includes(task.status) && <button disabled={busy} onClick={() => run({ type: 'task.cancel', id: task.id, expectedVersion: task.version })}>取消后续执行</button>}
      </article>)}
    </>}
  </section>;
}
const PolicyForm = forwardRef<DirtyHandle, { policy: Policy; busy: boolean; save(policy: Omit<Policy, 'version'>, version: number): Promise<Policy | undefined> }>(function PolicyForm({ policy, busy, save }, ref) {
  const [draft, setDraft] = useState(policy), [saved, setSaved] = useState(JSON.stringify(policy));
  const dirty = JSON.stringify(draft) !== saved;
  useDirtyGuard(ref, () => dirty);
  useEffect(() => { if (!dirty) { setDraft(policy); setSaved(JSON.stringify(policy)); } }, [policy.version]);
  const values = Object.values(draft.permissions), uniform = values.every(v => v === values[0]) ? values[0] : 'custom';
  return <form onSubmit={async e => { e.preventDefault(); const { version, ...input } = draft; const result = await save({ ...input, configured: true }, version); if (result) { setDraft(result); setSaved(JSON.stringify(result)); } }}>
    {!policy.configured && <p>尚未确认协作设置。以下只是可调整的起点，保存后才采用。</p>}
    <label>主动性<select aria-label="协作主动性" value={draft.initiative} onChange={e => setDraft({ ...draft, initiative: e.target.value as Policy['initiative'] })}><option value="respond">按我的指令进行</option><option value="suggest">主动提出建议</option><option value="advance">在授权内主动推进</option></select></label>
    <label>操作权限<select aria-label="协作操作权限" value={uniform} onChange={e => { if (e.target.value !== 'custom') setDraft({ ...draft, permissions: Object.fromEntries(operations.map(o => [o, e.target.value])) as Policy['permissions'] }); }}><option value="ask">操作前询问</option><option value="allow">允许操作</option><option value="deny">禁止操作</option><option value="custom" disabled>按详细操作分别配置</option></select></label>
    <label>创作参与度<select aria-label="协作创作参与度" value={draft.contribution} onChange={e => setDraft({ ...draft, contribution: e.target.value as Policy['contribution'] })}><option value="organize">以整理已有内容为主</option><option value="expand">允许补充与完善</option><option value="create">积极参与构思</option></select></label>
    <details><summary>详细操作权限</summary><div className="collaboration-permissions">{operations.map(o => <label key={o}>{labels[o]}<select aria-label={`${labels[o]}权限`} value={draft.permissions[o]} onChange={e => setDraft({ ...draft, permissions: { ...draft.permissions, [o]: e.target.value } })}><option value="allow">允许</option><option value="ask">询问</option><option value="deny">禁止</option></select></label>)}</div></details>
    <p>主动性和创作参与度分别保存，供后续真实模型使用；它们不会代替操作授权。已开始任务不因这里改为禁止就自动停止。</p><button disabled={busy} className="button-primary">保存协作设置</button>
  </form>;
});
