import { forwardRef, useEffect, useImperativeHandle, useState } from 'react';
import type { ContentObject, Definition, WorkspaceCommand, WorkspaceState } from '../../contracts/workspace.ts';
import { command, isFolder, locationsOf, titleOf } from '../../client/wiki.ts';
import type { DirtyHandle } from './WikiDocument.tsx';

export const WikiFields = forwardRef<DirtyHandle, { object: ContentObject; state: WorkspaceState; execute(command: WorkspaceCommand): Promise<WorkspaceState> }>(function WikiFields({ object, state, execute }, ref) {
  const writable = () => Object.fromEntries(Object.entries(object.fields).filter(([key]) => !key.startsWith('sys.')).map(([key, values]) => [key, state.definitions.find(d => d.id === key)?.type === 'json' ? values.map(v => JSON.stringify(v, null, 2)) : values]));
  const [fields, setFields] = useState<Record<string, unknown[]>>(writable), [base, setBase] = useState(state);
  const [saved, setSaved] = useState(JSON.stringify(writable()));
  const [attach, setAttach] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false), [notice, setNotice] = useState('');
  const dirty = JSON.stringify(fields) !== saved;
  useImperativeHandle(ref, () => ({ dirty: () => dirty }));
  useEffect(() => { if (!dirty) { const next = writable(); setFields(next); setSaved(JSON.stringify(next)); setBase(state); } }, [state.revision]);
  useEffect(() => { const guard = (e: BeforeUnloadEvent) => { if (dirty) { e.preventDefault(); e.returnValue = ''; } }; window.addEventListener('beforeunload', guard); return () => window.removeEventListener('beforeunload', guard); }, [dirty]);
  const definitions = state.definitions.filter(d => !d.system && (d.scope === 'global' || d.scope === object.worldId));
  const set = (id: string, index: number, value: unknown) => setFields(current => ({ ...current, [id]: current[id]!.map((v, i) => i === index ? value : v) }));
  const input = (d: Definition, value: unknown, index: number) => {
    const label = `${d.name} 第${index + 1}项`;
    if (d.type === 'boolean') return <input aria-label={label} type="checkbox" checked={value === true} onChange={e => set(d.id, index, e.target.checked)} />;
    if (d.type === 'choice') return <select aria-label={label} value={String(value)} onChange={e => set(d.id, index, e.target.value)}><option value="">请选择</option>{d.constraints.options?.map(o => <option key={o}>{o}</option>)}</select>;
    if (d.type === 'reference') return <select aria-label={label} value={(value as { ref?: string })?.ref ?? ''} onChange={e => set(d.id, index, { ref: e.target.value })}><option value="">选择对象</option>{state.objects.filter(o => !d.constraints.sameWorld || o.worldId === object.worldId).map(o => <option key={o.id} value={o.id}>{titleOf(state, o)} · {o.id.slice(0, 8)}</option>)}</select>;
    if (d.type === 'resource') return <select aria-label={label} value={value && typeof value === 'object' && 'resource' in value ? `${value.resource}:${'version' in value ? value.version : ''}` : ''} onChange={e => { const [resource, version] = e.target.value.split(':'); set(d.id, index, { resource, version: Number(version) }); }}><option value="">选择资源版本</option>{state.resourceVersions.filter(v => state.resources.some(r => r.id === v.id && (!d.constraints.sameWorld || r.worldId === object.worldId))).map(v => <option key={`${v.id}:${v.version}`} value={`${v.id}:${v.version}`}>{state.resources.find(r => r.id === v.id)?.path} · v{v.version}</option>)}</select>;
    if (d.type === 'json') return <textarea aria-label={label} value={String(value)} onChange={e => set(d.id, index, e.target.value)} />;
    return <input aria-label={label} type={d.type === 'number' ? 'number' : 'text'} value={typeof value === 'string' || typeof value === 'number' ? value : ''} onChange={e => set(d.id, index, d.type === 'number' && e.target.value !== '' ? Number(e.target.value) : e.target.value)} />;
  };
  return <section className="wiki-fields" aria-label="条目字段">
    <h3>字段</h3><p className="wiki-note">每项由同一个字段定义解释。修改类型或约束仍由服务端整体检查，不会静默丢值。</p>
    {Object.entries(fields).map(([id, values]) => {
      const d = state.definitions.find(d => d.id === id); if (!d) return null;
      return <fieldset key={id}><legend>{d.name} <small>{d.type} · {d.scope === 'global' ? '全局' : '当前世界'}</small></legend>
        {values.map((value, index) => <div className="wiki-field-value" key={index}>{input(d, value, index)}<button aria-label={`移除${d.name}第${index + 1}项`} onClick={() => setFields(current => ({ ...current, [id]: current[id]!.filter((_, i) => i !== index) }))}>移除值</button></div>)}
        <div className="wiki-toolbar"><button onClick={() => setFields(current => ({ ...current, [id]: [...current[id]!, d.type === 'boolean' ? false : d.type === 'number' ? 0 : d.type === 'reference' ? { ref: '' } : d.type === 'resource' ? { resource: '', version: 1 } : d.type === 'json' ? '{}' : d.type === 'choice' ? d.constraints.options?.[0] ?? '' : ''] }))}>添加值</button><button onClick={() => setFields(current => { const next = { ...current }; delete next[id]; return next; })}>移除此字段</button></div>
      </fieldset>;
    })}
    <div className="wiki-toolbar"><select aria-label="附加已有字段" value={attach} onChange={e => setAttach(e.target.value)}><option value="">选择已有字段</option>{definitions.filter(d => !(d.id in fields)).map(d => <option key={d.id} value={d.id}>{d.name} · {d.scope === 'global' ? '全局' : '本世界'}</option>)}</select><button disabled={!attach} onClick={() => { setFields(current => ({ ...current, [attach]: [] })); setAttach(''); }}>附加字段</button></div>
    <button className="button-primary" disabled={busy || !dirty} onClick={async () => {
      setBusy(true); setError(''); setNotice('');
      try { const encoded = Object.fromEntries(Object.entries(fields).map(([id, values]) => [id, state.definitions.find(d => d.id === id)?.type === 'json' ? values.map(value => JSON.parse(String(value))) : values])); const old = base.objects.find(o => o.id === object.id)!;
        const candidate = { ...object, fields: { ...Object.fromEntries(Object.entries(object.fields).filter(([id]) => id.startsWith('sys.'))), ...encoded } };
        if (isFolder(state, candidate) && state.objects.some(o => o.id !== object.id && o.worldId === object.worldId && isFolder(state, o) && titleOf(state, o) === titleOf(state, candidate) && (locationsOf(state, candidate).length ? locationsOf(state, candidate).some(id => locationsOf(state, o).includes(id)) : !locationsOf(state, o).length))) throw new Error('此位置已有同名文件夹，请改名或取消，不会自动合并。');
        const latest = await execute(command(base, object.worldId, [{ type: 'object.update', id: object.id, set: encoded, unset: Object.keys(old.fields).filter(id => !id.startsWith('sys.') && !(id in fields)) }])); setBase(latest); setSaved(JSON.stringify(fields)); setNotice('字段已保存'); }
      catch (e) { setError((e as Error).message); } finally { setBusy(false); }
    }}>保存字段</button>
    {error && <p role="alert" className="inline-error">未保存：{error} 输入已保留。</p>}<p role="status">{notice || (dirty ? '字段有未保存修改' : '')}</p>
    <details><summary>系统维护信息</summary><dl>{state.definitions.filter(d => d.system).map(d => <div key={d.id}><dt>{d.name}</dt><dd>{JSON.stringify(object.fields[d.id])}</dd></div>)}</dl></details>
  </section>;
});
