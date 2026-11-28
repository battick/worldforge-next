import { forwardRef, useEffect, useState } from 'react';
import type { ContentObject, WorkspaceCommand, WorkspaceState } from '../../contracts/workspace.ts';
import { isRelationDefinition, relationFields } from '../../contracts/relations.ts';
import { relationDefinitionCommand, titleOf } from '../../client/wiki.ts';
import { useDirtyGuard, type DirtyHandle } from './hooks/useDirtyGuard.ts';

export const WikiRelations = forwardRef<DirtyHandle, { state: WorkspaceState; worldId: string; execute(c: WorkspaceCommand): Promise<WorkspaceState> }>(function WikiRelations({ state, worldId, execute }, ref) {
  const [id, setId] = useState(''), [name, setName] = useState(''), [selected, setSelected] = useState<string[]>([]), [defaults, setDefaults] = useState('{}');
  const [base, setBase] = useState(state), [error, setError] = useState(''), [notice, setNotice] = useState(''), [busy, setBusy] = useState(false);
  const signature = JSON.stringify({ id, name, selected, defaults }), [saved, setSaved] = useState(signature);
  const dirty = signature !== saved;
  useDirtyGuard(ref, () => dirty || busy);
  useEffect(() => { if (!dirty) setBase(state); }, [state.revision]);
  const choose = (object?: ContentObject) => {
    if (busy) return;
    if (dirty && !window.confirm('关系定义有未保存修改，确定放弃并切换吗？')) return;
    const configs = object ? relationFields(state, object) : [], next = { id: object?.id ?? '', name: object ? titleOf(state, object) : '', selected: configs.map(c => c.fieldId), defaults: JSON.stringify(Object.fromEntries(configs.filter(c => c.defaults).map(c => [c.fieldId, c.defaults])), null, 2) };
    setId(next.id); setName(next.name); setSelected(next.selected); setDefaults(next.defaults); setSaved(JSON.stringify(next)); setBase(state); setError(''); setNotice('');
  };
  const fields = state.definitions.filter(d => !d.system && (d.scope === worldId || d.scope === 'global') && !d.marks.some(m => ['relation-definition', 'relation-fields', 'relation-type', 'world-status', 'navigation-folder'].includes(m)));
  return <section className="wiki-definition-panel" aria-label="关系定义管理"><h2>关系定义</h2><p>例如先定义“师徒”采用哪些字段，再创建多条师徒关系。定义本身也是普通条目，名称、用途和字段配置都由字段记录。</p>
    <div className="wiki-definition-layout"><div className="wiki-definition-list"><button disabled={busy} onClick={() => choose()}>新建关系定义</button>{state.objects.filter(o => o.worldId === worldId && isRelationDefinition(state, o)).map(o => <button disabled={busy} key={o.id} onClick={() => choose(o)}>{titleOf(state, o)}</button>)}</div>
    <form onSubmit={async e => { e.preventDefault(); setBusy(true); setError(''); setNotice(''); try {
      const values: unknown = JSON.parse(defaults);
      if (!values || typeof values !== 'object' || Array.isArray(values) || Object.entries(values).some(([key, value]) => !selected.includes(key) || !Array.isArray(value))) throw new Error('初始值需要一个对象：字段ID对应值数组，且字段必须已选中。');
      const initial = values as Record<string, unknown[]>;
      const configs = selected.map(fieldId => ({ fieldId, ...(initial[fieldId] ? { defaults: initial[fieldId] } : {}) }));
      const result = relationDefinitionCommand(base, worldId, name.trim(), configs, id || undefined), next = await execute(result.command);
      setId(result.id); const object = next.objects.find(o => o.id === result.id)!; const actual = relationFields(next, object);
      const nextSelected = actual.map(c => c.fieldId); setSelected(nextSelected); setBase(next); setSaved(JSON.stringify({ id: result.id, name, selected: nextSelected, defaults })); setNotice('关系定义已保存，相关实例已一起核对并更新');
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); } }}>
      <label>关系名称<input disabled={busy} aria-label="关系定义名称" value={name} onChange={e => setName(e.target.value)} required /></label>
      <fieldset disabled={busy}><legend>采用的字段</legend><div className="wiki-marks">{fields.map(d => <label key={d.id}><input type="checkbox" aria-label={`采用${d.name}`} checked={selected.includes(d.id)} onChange={e => setSelected(ids => e.target.checked ? [...ids, d.id] : ids.filter(id => id !== d.id))} />{d.name} <small>{d.id}</small></label>)}</div></fieldset>
      <details><summary>新附加字段的初始值（可选）</summary><p>留空对象表示由创建关系时填写。格式是字段ID对应值数组，例如日期数字字段可填一个数字数组。已有实例填写过的值不会被覆盖。</p><textarea disabled={busy} aria-label="关系字段初始值" value={defaults} onChange={e => setDefaults(e.target.value)} /></details>
      <p className="wiki-note">未选起点或目标字段时会复用或补充相应用途的通用字段。新增配置会附加到相关实例；取消采用保留已有值。新约束不兼容时整次保存失败，可在字段定义的整体修改中一同转换旧值。</p>
      <button className="button-primary" disabled={busy}>保存关系定义</button>{error && <p role="alert" className="inline-error">未保存：{error} 输入已保留。</p>}<p role="status">{notice}</p>
    </form></div>
  </section>;
});
