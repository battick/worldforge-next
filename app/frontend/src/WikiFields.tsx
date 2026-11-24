import { useState, type Dispatch, type SetStateAction } from 'react';
import type { ContentObject, Definition, WorkspaceState } from '../../contracts/workspace.ts';
import { titleOf } from '../../client/wiki.ts';
import { isRelationDefinition } from '../../contracts/relations.ts';

export function writableFields(state: WorkspaceState, object: ContentObject): Record<string, unknown[]> {
  return Object.fromEntries(Object.entries(object.fields).filter(([key]) => !key.startsWith('sys.')).map(([key, values]) => [key, state.definitions.find(d => d.id === key)?.type === 'json' ? values.map(v => JSON.stringify(v, null, 2)) : values]));
}
export function decodeFields(state: WorkspaceState, fields: Record<string, unknown[]>): Record<string, unknown[]> {
  return Object.fromEntries(Object.entries(fields).map(([id, values]) => [id, state.definitions.find(d => d.id === id)?.type === 'json' ? values.map(v => JSON.parse(String(v))) : values]));
}
export function WikiFields({ object, state, fields, setFields, editing }: { object: ContentObject; state: WorkspaceState; fields: Record<string, unknown[]>; setFields: Dispatch<SetStateAction<Record<string, unknown[]>>>; editing: boolean }) {
  const [attach, setAttach] = useState('');
  const definitions = state.definitions.filter(d => !d.system && (d.scope === 'global' || d.scope === object.worldId));
  const set = (id: string, index: number, value: unknown) => setFields(current => ({ ...current, [id]: current[id]!.map((v, i) => i === index ? value : v) }));
  const input = (d: Definition, value: unknown, index: number) => {
    const label = `${d.name} 第${index + 1}项`;
    if (d.type === 'boolean') return <input aria-label={label} type="checkbox" checked={value === true} onChange={e => set(d.id, index, e.target.checked)} />;
    if (d.type === 'choice') return <select aria-label={label} value={String(value)} onChange={e => set(d.id, index, e.target.value)}><option value="">请选择</option>{d.constraints.options?.map(o => <option key={o}>{o}</option>)}</select>;
    if (d.type === 'reference') return <select aria-label={label} value={(value as { ref?: string })?.ref ?? ''} onChange={e => set(d.id, index, { ref: e.target.value })}><option value="">选择对象</option>{state.objects.filter(o => (!d.constraints.sameWorld || o.worldId === object.worldId) && (!d.marks.includes('relation-type') || isRelationDefinition(state, o))).map(o => <option key={o.id} value={o.id}>{titleOf(state, o)} · {o.id.slice(0, 8)}</option>)}</select>;
    if (d.type === 'resource') return <select aria-label={label} value={value && typeof value === 'object' && 'resource' in value ? `${value.resource}:${'version' in value ? value.version : ''}` : ''} onChange={e => { const [resource, version] = e.target.value.split(':'); set(d.id, index, { resource, version: Number(version) }); }}><option value="">选择资源版本</option>{state.resourceVersions.filter(v => state.resources.some(r => r.id === v.id && (!d.constraints.sameWorld || r.worldId === object.worldId))).map(v => <option key={`${v.id}:${v.version}`} value={`${v.id}:${v.version}`}>{state.resources.find(r => r.id === v.id)?.path} · v{v.version}</option>)}</select>;
    if (d.type === 'json') return <textarea aria-label={label} value={String(value)} onChange={e => set(d.id, index, e.target.value)} />;
    return <input aria-label={label} type={d.type === 'number' ? 'number' : 'text'} value={typeof value === 'string' || typeof value === 'number' ? value : ''} onChange={e => set(d.id, index, d.type === 'number' && e.target.value !== '' ? Number(e.target.value) : e.target.value)} />;
  };
  return <section className="wiki-fields" aria-label="条目字段">
    <h3>字段</h3><p className="wiki-note">每项由同一个字段定义解释。修改类型或约束仍由服务端整体检查，不会静默丢值。</p>
    {Object.entries(fields).map(([id, values]) => {
      const d = state.definitions.find(d => d.id === id); if (!d) return null;
      return <fieldset key={id}><legend>{d.name} <small>{d.type} · {d.scope === 'global' ? '全局' : '当前世界'}</small></legend>
        {values.map((value, index) => <div className="wiki-field-value" key={index}>{editing ? input(d, value, index) : <span>{d.type === 'reference' ? titleOf(state, state.objects.find(o => o.id === (value as { ref?: string })?.ref) ?? object) : d.type === 'resource' ? JSON.stringify(value) : String(value)}</span>}{editing && <button type="button" aria-label={`移除${d.name}第${index + 1}项`} onClick={() => setFields(current => ({ ...current, [id]: current[id]!.filter((_, i) => i !== index) }))}>移除值</button>}</div>)}
        {editing && <div className="wiki-toolbar"><button type="button" onClick={() => setFields(current => ({ ...current, [id]: [...current[id]!, d.type === 'boolean' ? false : d.type === 'number' ? 0 : d.type === 'reference' ? { ref: '' } : d.type === 'resource' ? { resource: '', version: 1 } : d.type === 'json' ? '{}' : d.type === 'choice' ? d.constraints.options?.[0] ?? '' : ''] }))}>添加值</button><button type="button" onClick={() => setFields(current => { const next = { ...current }; delete next[id]; return next; })}>移除此字段</button></div>}
      </fieldset>;
    })}
    {editing && <div className="wiki-toolbar"><select aria-label="附加已有字段" value={attach} onChange={e => setAttach(e.target.value)}><option value="">选择已有字段</option>{definitions.filter(d => !(d.id in fields)).map(d => <option key={d.id} value={d.id}>{d.name} · {d.scope === 'global' ? '全局' : '本世界'}</option>)}</select><button type="button" disabled={!attach} onClick={() => { setFields(current => ({ ...current, [attach]: [] })); setAttach(''); }}>附加字段</button></div>}
    <details><summary>系统维护信息</summary><dl>{state.definitions.filter(d => d.system).map(d => <div key={d.id}><dt>{d.name}</dt><dd>{JSON.stringify(object.fields[d.id])}</dd></div>)}</dl></details>
  </section>;
}
