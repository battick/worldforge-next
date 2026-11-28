import { forwardRef, useEffect, useRef, useState } from 'react';
import { marks, type DefinitionInput, type WorkspaceCommand, type WorkspaceState } from '../../contracts/workspace.ts';
import { command } from '../../client/wiki.ts';
import { useDirtyGuard, type DirtyHandle } from './hooks/useDirtyGuard.ts';

export const WikiDefinitions = forwardRef<DirtyHandle, { state: WorkspaceState; worldId: string; execute(c: WorkspaceCommand): Promise<WorkspaceState> }>(function WikiDefinitions({ state, worldId, execute }, ref) {
  const blank = (): DefinitionInput => ({ id: crypto.randomUUID(), scope: worldId, name: '', type: 'text', marks: [], constraints: {} });
  const [draft, setDraft] = useState(blank), [base, setBase] = useState(state.revision), [constraints, setConstraints] = useState('{}');
  const [error, setError] = useState(''), [notice, setNotice] = useState(''), [busy, setBusy] = useState(false);
  const signature = JSON.stringify({ draft, constraints });
  const [saved, setSaved] = useState(signature);
  const atomic = useRef<DirtyHandle>(null);
  const dirty = signature !== saved;
  useEffect(() => { if (!dirty) setBase(state.revision); }, [state.revision]);
  useDirtyGuard(ref, () => dirty || busy || Boolean(atomic.current?.dirty()));
  const choose = (definition: DefinitionInput) => {
    if (busy) return;
    if (dirty && !window.confirm('字段定义有未保存修改，确定放弃并切换吗？')) return;
    const next = JSON.stringify(definition.constraints, null, 2);
    setDraft(definition); setConstraints(next); setSaved(JSON.stringify({ draft: definition, constraints: next })); setBase(state.revision); setError(''); setNotice('');
  };
  return <section className="wiki-definition-panel"><h2>字段定义</h2><p>已有合适字段可以直接附加到条目；新字段默认只用于当前世界。全局定义的修改会影响所有使用它的世界。</p>
    <div className="wiki-definition-layout"><div className="wiki-definition-list"><button disabled={busy} onClick={() => choose(blank())}>新建字段定义</button>{state.definitions.filter(d => d.scope === worldId || d.scope === 'global').map(d => <button disabled={busy} key={d.id} onClick={() => { const { version: _v, ...definition } = d; choose(definition); }}>{d.name}<small>{d.system ? '系统维护' : d.scope === 'global' ? '全局' : '本世界'} · {d.type}</small></button>)}</div>
    <form onSubmit={async e => { e.preventDefault(); setBusy(true); setError(''); setNotice(''); try {
      const next = { ...draft, constraints: JSON.parse(constraints) };
      const result = await execute({ ...command(state, worldId, [{ type: 'definition.put', definition: next }]), baseRevision: base });
      setBase(result.revision); setSaved(signature); setNotice('字段定义已保存');
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); } }}>
      <label>字段名称<input disabled={busy} aria-label="字段定义名称" value={draft.name} required onChange={e => setDraft({ ...draft, name: e.target.value })} /></label>
      <label>值类型<select aria-label="字段定义类型" value={draft.type} disabled={busy || Boolean(draft.system)} onChange={e => setDraft({ ...draft, type: e.target.value as DefinitionInput['type'] })}>{['text', 'number', 'boolean', 'choice', 'link', 'reference', 'resource', 'json'].map(type => <option key={type}>{type}</option>)}</select></label>
      <label>归属<select aria-label="字段定义归属" value={draft.scope} disabled={busy || state.definitions.some(d => d.id === draft.id)} onChange={e => setDraft({ ...draft, scope: e.target.value })}><option value={worldId}>当前世界</option><option value="global">所有世界共用</option></select></label>
      <label>用途说明<textarea disabled={busy} aria-label="字段用途说明" value={draft.comment ?? ''} onChange={e => setDraft({ ...draft, comment: e.target.value })} /></label>
      <fieldset disabled={busy || Boolean(draft.system)}><legend>功能标记</legend><div className="wiki-marks">{marks.filter(mark => !['identity', 'kind', 'created', 'updated', 'version'].includes(mark)).map(mark => <label key={mark}><input type="checkbox" checked={draft.marks.includes(mark)} onChange={e => setDraft({ ...draft, marks: e.target.checked ? [...draft.marks, mark] : draft.marks.filter(m => m !== mark) })} />{mark}</label>)}</div></fieldset>
      <label>约束（JSON；空对象表示不额外限制）<textarea aria-label="字段约束" disabled={busy || Boolean(draft.system)} value={constraints} onChange={e => setConstraints(e.target.value)} /></label>
      <p className="wiki-note">类型、数量、选项等仍统一校验；不匹配的旧值不会被自动改掉。字段定义与旧值需要一起变更时，可在“整体修改”中提交转换。</p>
      <button type="submit" className="button-primary" disabled={busy}>保存字段定义</button>
      {error && <p role="alert" className="inline-error">未保存：{error}</p>}<p role="status">{notice}</p>
    </form></div>
    <AtomicEdit ref={atomic} state={state} worldId={worldId} execute={execute} />
  </section>;
});
const AtomicEdit = forwardRef<DirtyHandle, { state: WorkspaceState; worldId: string; execute(c: WorkspaceCommand): Promise<WorkspaceState> }>(function AtomicEdit({ state, worldId, execute }, ref) {
  const [changes, setChanges] = useState('[]'), [base, setBase] = useState(state.revision), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(changes);
  useDirtyGuard(ref, () => changes !== saved || busy);
  return <details><summary>整体修改（同时转换定义和关联值）</summary><p>填写changes数组。所有修改一起校验和保存，任意一项不合法则全部不生效。</p><textarea disabled={busy} className="wiki-command" aria-label="整体修改内容" value={changes} onChange={e => setChanges(e.target.value)} /><button disabled={busy} onClick={() => { setBase(state.revision); setError(''); }}>采用当前版本 {state.revision}</button><button disabled={busy} onClick={async () => { setBusy(true); setError(''); try { const next = await execute({ ...command(state, worldId, JSON.parse(changes)), baseRevision: base }); setBase(next.revision); setSaved(changes); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } }}>应用整体修改</button><p>准备版本 {base}</p>{error && <p role="alert" className="inline-error">未保存：{error}</p>}</details>;
});
