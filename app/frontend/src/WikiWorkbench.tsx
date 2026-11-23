import { forwardRef, useEffect, useRef, useState } from 'react';
import type { ContentObject, WorkspaceCommand, WorkspaceState, WorkspaceView } from '../../contracts/workspace.ts';
import { command, confirmWorld, encodeBytes, isFolder, kindOf, locationsOf, newObject, newWorld, relocate, searchObjects, titleOf, worldStatus, type SourceFile } from '../../client/wiki.ts';
import { api } from './api.ts';
import { ApiClientError } from '../../client/index.ts';
import { useDirtyGuard } from './hooks/useDirtyGuard.ts';
import { WikiDocument, type DirtyHandle } from './WikiDocument.tsx';
import { WikiFields } from './WikiFields.tsx';
import { WikiDefinitions } from './WikiDefinitions.tsx';
import { WikiPreviewCard, WikiPreviewContext } from './WikiMarkdown.tsx';
import { WorldSpace } from './WorldSpace.tsx';

export function WikiWorkbench() {
  const [view, setView] = useState<WorkspaceView>();
  const [worldId, setWorldId] = useState(''), [selected, setSelected] = useState(''), [tabs, setTabs] = useState<string[]>([]);
  const [section, setSection] = useState<'wiki' | 'space' | 'definitions' | 'history'>('wiki');
  const [query, setQuery] = useState(''), [field, setField] = useState(''), [fieldValue, setFieldValue] = useState(''), [includeFolders, setIncludeFolders] = useState(false);
  const [folder, setFolder] = useState('*'), [targetFolder, setTargetFolder] = useState('');
  const [pins, setPins] = useState<string[]>([]), [error, setError] = useState(''), [busy, setBusy] = useState(false), [notice, setNotice] = useState('');
  const [worldForm, setWorldForm] = useState(false), [newKind, setNewKind] = useState<'entry' | 'relation' | 'folder'>();
  const [generation, setGeneration] = useState(0), [uncertain, setUncertain] = useState(false);
  const [menu, setMenu] = useState<{ id: string; from: string }>();
  const actions = useRef<HTMLDivElement>(null);
  const pending = useRef<WorkspaceCommand | undefined>(undefined), sending = useRef(false);
  const handles = useRef<Record<string, DirtyHandle | null>>({});
  const worldDraft = useRef<DirtyHandle>(null);
  useDirtyGuard(undefined, () => Boolean(pending.current));
  const hasDirty = () => Object.values(handles.current).some(ref => ref?.dirty());
  const load = async () => { const next = await api.workspace(); setView(next); return next; };
  useEffect(() => { load().catch(e => setError(e.message)); }, []);
  const route = (state: WorkspaceState, id: string) => {
    const object = state.objects.find(o => o.id === id); if (!object) { setError('引用的条目不存在，不会自动创建。'); return; }
    if (worldId && object.worldId !== worldId && hasDirty() && !window.confirm('其他世界有未保存内容，确定切换并放弃这些修改吗？')) { history.replaceState(null, '', `#wiki/${worldId}/${selected || worldId}`); return; }
    if (object.worldId !== worldId) { setWorldId(object.worldId); setTabs([id]); setPins([]); setFolder('*'); setTargetFolder(''); setNewKind(undefined); }
    else setTabs(current => current.includes(id) ? current : [...current, id]);
    setMenu(undefined); setSelected(id); setSection('wiki'); location.hash = `wiki/${object.worldId}/${id}`;
  };
  useEffect(() => {
    if (!view) return;
    const apply = () => {
      if (!location.hash.startsWith('#wiki/')) return;
      const [, world, id] = location.hash.slice(1).split('/');
      if (world && id && (world !== worldId || id !== selected)) {
        const object = view.state.objects.find(o => o.id === id && o.worldId === world);
        if (object) route(view.state, id); else setError('这个世界或条目已不存在。');
      }
    };
    apply(); window.addEventListener('hashchange', apply); return () => window.removeEventListener('hashchange', apply);
  }, [view, worldId, selected]);
  const execute = async (request: WorkspaceCommand) => {
    if (sending.current) throw new Error('上一项保存尚未完成，请稍后再试。');
    if (pending.current && pending.current.operationId !== request.operationId) throw new Error('上一项保存结果尚未确认，请先点击“核对并重试原保存”。');
    pending.current = request; sending.current = true;
    try {
      try { await api.execute(request); }
      catch (e) {
        if (e instanceof ApiClientError && e.status >= 400 && e.status < 500) throw e;
        // A lost response may follow a successful commit. Reuse the complete original command.
        await api.execute(request);
      }
      const next = await load(); pending.current = undefined; setUncertain(false); return next.state;
    } catch (e) {
      if (e instanceof ApiClientError && e.status >= 400 && e.status < 500) { pending.current = undefined; setUncertain(false); }
      else setUncertain(true);
      throw e;
    } finally { sending.current = false; }
  };
  const run = async (action: () => Promise<void>) => { setError(''); setNotice(''); setBusy(true); try { await action(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } };
  if (!view) return <section className="wiki-workbench"><p role="status">{error || '正在读取世界…'}</p></section>;
  const state = view.state, root = state.objects.find(o => o.id === worldId), object = state.objects.find(o => o.id === selected);
  const open = (id: string) => route(state, id);
  const folders = state.objects.filter(o => o.worldId === worldId && isFolder(state, o));
  const entries = searchObjects(state, worldId, query, field, fieldValue).filter(hit => (includeFolders || !isFolder(state, hit.object)) && (folder === '*' || folder === '' ? folder === '*' || !locationsOf(state, hit.object).length : locationsOf(state, hit.object).includes(folder)));
  const move = (item: ContentObject, destination: string, source = folder, add = false) => run(async () => { await execute(relocate(state, item, destination, source === '*' ? undefined : source, add)); setNotice(add ? '位置已添加，同一份条目没有复制。' : '位置已更新，其他位置和内容保留。'); });
  const pin = (id: string) => setPins(ids => ids.includes(id) ? ids : [...ids, id]);
  const begin = (kind: 'entry' | 'relation' | 'folder') => { if (kind === newKind) return; if (!handles.current.create?.dirty() || window.confirm('新内容尚未保存，确定放弃并重新填写吗？')) setNewKind(kind); };
  return <WikiPreviewContext.Provider value={pin}><section className="wiki-workbench" aria-label="手工Wiki">
    <div className="wiki-heading"><div><span className="eyebrow">世界与资料</span><h1>我的世界</h1></div><button className="button-primary" onClick={() => { if (!worldForm || !worldDraft.current?.dirty() || window.confirm('世界草案尚未保存，确定关闭表单吗？')) setWorldForm(open => !open); }}>创建世界</button></div>
    {worldForm && <CreateWorld ref={worldDraft} state={state} execute={execute} onCreated={(next, id) => { setWorldForm(false); route(next, id); }} />}
    <p className="wiki-note">选择下面的世界，进入条目、正文、资料空间、字段和修改记录；也可以创建新世界。</p>
    <div className="wiki-world-list">{state.worlds.map(w => {
      const object = state.objects.find(o => o.id === w.rootId)!;
      return <button key={w.id} className={w.id === worldId ? 'selected' : ''} aria-pressed={w.id === worldId} onClick={() => open(w.rootId)}>{titleOf(state, object)}<small>{worldStatus(state, object) === 'created' ? '正式世界' : worldStatus(state, object) === 'draft' ? '创建草案' : '已有资料'}</small><small>打开世界 →</small></button>;
    })}{!state.worlds.length && <p>可以从空白、一个想法或已有资料开始，之后随时补全。</p>}</div>
    {root && <>
      <div className="wiki-world-heading"><h2>{titleOf(state, root)}</h2><span className="wiki-note">{worldStatus(state, root) === 'created' ? '已确认创建' : '草案和已有内容都会保存；可以直接进入详细编辑。'}</span>{worldStatus(state, root) !== 'created' && <button disabled={busy} onClick={() => run(async () => { await execute(confirmWorld(state, worldId)); setNotice('世界已确认创建，现有条目和资料全部保留。'); })}>确认创建世界</button>}<button onClick={() => { if (!hasDirty() || window.confirm('重新读取会放弃未保存内容，确定吗？')) void run(async () => { await load(); setGeneration(n => n + 1); setNewKind(undefined); }); }}>重新读取世界</button></div>
      <nav className="wiki-section-tabs" aria-label="世界功能">{([['wiki', 'Wiki'], ['space', '空间'], ['definitions', '字段定义'], ['history', '修改记录']] as const).map(([key, label]) => <button key={key} aria-pressed={section === key} onClick={() => setSection(key)}>{label}</button>)}</nav>
      <div hidden={section !== 'wiki'}>
        <div className="wiki-layout"><aside className="wiki-sidebar">
          <div className="wiki-toolbar"><button onClick={() => begin('entry')}>新建条目</button><button onClick={() => begin('relation')}>新建关系</button><button onClick={() => begin('folder')}>新建文件夹</button></div>
          <button className="wiki-root-link" onClick={() => open(worldId)}>世界蓝图与详细编辑</button>
          <div className="wiki-tree" aria-label="文件夹导航"><button aria-pressed={folder === '*'} onClick={() => setFolder('*')}>全部条目</button><button aria-pressed={folder === ''} onClick={() => setFolder('')} onDragOver={e => e.preventDefault()} onDrop={e => { e.preventDefault(); try { const drag = JSON.parse(e.dataTransfer.getData('text/plain')); const item = state.objects.find(o => o.id === drag.id); if (item) void move(item, '', drag.from); } catch { setError('无法读取拖动的位置。'); } }}>待整理</button>
            <FolderTree state={state} folders={folders} parent="" path={[]} selected={folder} onSelect={setFolder} onDrop={(id, source, target) => { const item = state.objects.find(o => o.id === id); if (item) void move(item, target, source); }} />
            {folders.length > 0 && <details><summary>所有文件夹字段记录</summary>{folders.map(o => <button key={o.id} onClick={() => { setFolder(o.id); open(o.id); }}>{titleOf(state, o)}</button>)}</details>}
          </div>
          <label>搜索条目<input type="search" aria-label="搜索世界条目" value={query} onChange={e => setQuery(e.target.value)} placeholder="名称、字段或正文" /></label>
          <details><summary>筛选条件</summary><label>使用字段<select aria-label="筛选字段" value={field} onChange={e => setField(e.target.value)}><option value="">不限</option>{state.definitions.filter(d => d.scope === 'global' || d.scope === worldId).map(d => <option key={d.id} value={d.id}>{d.name}</option>)}</select></label><label>字段内容<input aria-label="筛选字段内容" disabled={!field} value={fieldValue} onChange={e => setFieldValue(e.target.value)} /></label><label><input type="checkbox" checked={includeFolders} onChange={e => setIncludeFolders(e.target.checked)} />包含文件夹条目</label></details>
          <ul className="wiki-results" aria-label="条目列表">{entries.map(({ object: item, snippet }) => <li key={item.id} draggable onDragStart={e => e.dataTransfer.setData('text/plain', JSON.stringify({ id: item.id, from: folder }))} onContextMenu={e => { e.preventDefault(); open(item.id); setMenu({ id: item.id, from: folder }); }}><button aria-pressed={item.id === selected} onClick={() => open(item.id)}>{kindOf(item) === 'relation' ? '◇ ' : ''}{titleOf(state, item)}<small><Highlight text={snippet} query={query} /></small></button><button aria-label={`固定预览${titleOf(state, item)}`} onClick={() => pin(item.id)}>预览</button></li>)}</ul>
          {menu && state.objects.some(o => o.id === menu.id) && <section className="wiki-context-menu" aria-label="条目右键操作"><strong>{titleOf(state, state.objects.find(o => o.id === menu.id)!)}</strong><label>添加位置<select aria-label="右键添加位置" value={targetFolder} onChange={e => setTargetFolder(e.target.value)}><option value="">选择文件夹</option>{folders.filter(f => f.id !== menu.id).map(f => <option key={f.id} value={f.id}>{titleOf(state, f)}</option>)}</select></label><button disabled={!targetFolder || busy} onClick={() => move(state.objects.find(o => o.id === menu.id)!, targetFolder, menu.from, true)}>添加此位置</button><button disabled={busy || !locationsOf(state, state.objects.find(o => o.id === menu.id)!).includes(menu.from)} onClick={() => move(state.objects.find(o => o.id === menu.id)!, '', menu.from)}>移除此位置</button><button onClick={() => { actions.current?.scrollIntoView({ behavior: 'smooth', block: 'center' }); setMenu(undefined); }}>删除内容与更多操作</button><button onClick={() => setMenu(undefined)}>关闭操作菜单</button></section>}
          {!entries.length && <p className="wiki-note">这里还没有匹配的条目。</p>}
        </aside><div className="wiki-content">
          {newKind && <CreateObject ref={handle => { handles.current.create = handle; }} key={newKind} state={state} worldId={worldId} kind={newKind} folder={folder} execute={execute} onClose={() => { if (!handles.current.create?.dirty() || window.confirm('新内容尚未保存，确定取消吗？')) setNewKind(undefined); }} onCreated={(next, id) => { setNewKind(undefined); route(next, id); }} />}
          <div className="wiki-tabs" role="tablist" aria-label="已打开条目">{tabs.map(id => { const item = state.objects.find(o => o.id === id); if (!item) return null; return <div key={id}><button role="tab" aria-selected={id === selected} onClick={() => open(id)}>{titleOf(state, item)}</button><button aria-label={`关闭${titleOf(state, item)}`} onClick={() => {
            if ((handles.current[`body:${id}`]?.dirty() || handles.current[`fields:${id}`]?.dirty()) && !window.confirm('此条目有未保存内容，确定关闭吗？')) return;
            const remaining = tabs.filter(t => t !== id); setTabs(remaining); if (selected === id) setSelected(remaining.at(-1) ?? '');
          }}>×</button></div>; })}</div>
          {tabs.map(id => { const item = state.objects.find(o => o.id === id); if (!item) return null; return <div key={`${id}:${generation}`} hidden={selected !== id} className="wiki-entry"><div className="wiki-entry-heading"><h2>{titleOf(state, item)}</h2><small>{item.id}</small></div>
            <WikiDocument ref={handle => { handles.current[`body:${id}`] = handle; }} object={item} state={state} execute={execute} onOpen={open} />
            <WikiFields ref={handle => { handles.current[`fields:${id}`] = handle; }} object={item} state={state} execute={execute} />
          </div>; })}
          {object && kindOf(object) !== 'world' && <div ref={actions} className="wiki-entry-actions"><h3>位置与条目操作</h3><p className="wiki-note">当前位置字段：{locationsOf(state, object).map(id => titleOf(state, state.objects.find(o => o.id === id)!)).join(' / ') || '待整理'}</p><select aria-label="目标文件夹" value={targetFolder} onChange={e => setTargetFolder(e.target.value)}><option value="">待整理 / 不指定文件夹</option>{folders.filter(f => f.id !== object.id).map(f => <option key={f.id} value={f.id}>{titleOf(state, f)}</option>)}</select>
            <button disabled={busy} onClick={() => move(object, targetFolder)}>移动当前位置</button><button disabled={busy || !targetFolder} onClick={() => move(object, targetFolder, folder, true)}>添加到其他位置</button><button disabled={busy || !locationsOf(state, object).includes(folder)} onClick={() => move(object, '', folder)}>移除当前位置</button>
            <button disabled={busy || (isFolder(state, object) && state.objects.some(o => locationsOf(state, o).includes(object.id)))} onClick={() => { if (window.confirm('删除这个条目的内容？这与移除位置不同，仍被其他资料引用时会拒绝。')) void run(async () => { const next = await execute(command(state, worldId, [{ type: 'object.delete', id: object.id }])); setTabs(ids => ids.filter(id => id !== object.id)); route(next, worldId); }); }}>删除条目</button>
            {isFolder(state, object) && <p className="wiki-note">文件夹名称、用途和上级位置都来自字段。非空目录的级联删除尚未确认；可以编辑其位置字段，或先移出所有位置再删除空目录。</p>}
          </div>}
        </div></div>
        <div className="wiki-previews" aria-label="固定预览">{pins.map((id, index) => <WikiPreviewCard key={id} id={id} index={index} state={state} onOpen={open} onClose={() => setPins(ids => ids.filter(value => value !== id))} />)}</div>
      </div>
      <div hidden={section !== 'space'}><WorldSpace ref={handle => { handles.current.space = handle; }} key={`${worldId}:${generation}`} state={state} worldId={worldId} execute={execute} onOpen={open} /></div>
      <div hidden={section !== 'definitions'}><WikiDefinitions ref={handle => { handles.current.definitions = handle; }} key={`${worldId}:${generation}`} state={state} worldId={worldId} execute={execute} /></div>
      {section === 'history' && <section><h2>修改记录</h2><p>这里展示已保存的实际前后变化；回滚执行将在后续阶段接入。</p>{view.history.filter(h => h.changes.some(c => { const value = c.after ?? c.before; return value && typeof value === 'object' && ('worldId' in value && value.worldId === worldId || 'id' in value && value.id === worldId); })).map(h => <details key={h.operationId}><summary>版本 {h.revision} · {h.changes.length} 项修改 · {new Date(h.createdAt).toLocaleString()}</summary><pre>{JSON.stringify(h.changes, null, 2)}</pre></details>)}</section>}
    </>}
    {uncertain && <div role="alert" className="connection-warning">保存结果尚未确认。保留本页，先核对原保存，再准备其他修改。<button disabled={busy} onClick={() => run(async () => { if (pending.current) { await execute(pending.current); setNotice('原保存已核对；资料只应用一次。未保存输入仍保留，可核对后重新读取世界。'); } })}>核对并重试原保存</button></div>}
    {error && <p role="alert" className="inline-error">{error}</p>}<p role="status">{notice}</p>
  </section></WikiPreviewContext.Provider>;
}
function Highlight({ text, query }: { text: string; query: string }) {
  const index = query ? text.toLocaleLowerCase().indexOf(query.toLocaleLowerCase()) : -1;
  return index < 0 ? <>{text}</> : <>{text.slice(0, index)}<mark>{text.slice(index, index + query.length)}</mark>{text.slice(index + query.length)}</>;
}
function FolderTree({ state, folders, parent, path, selected, onSelect, onDrop }: { state: WorkspaceState; folders: ContentObject[]; parent: string; path: string[]; selected: string; onSelect(id: string): void; onDrop(id: string, from: string, target: string): void }) {
  return <ul>{folders.filter(f => parent ? locationsOf(state, f).includes(parent) : !locationsOf(state, f).length).map(f => <li key={f.id} onDragOver={e => { e.preventDefault(); e.stopPropagation(); }} onDrop={e => { e.preventDefault(); e.stopPropagation(); try { const item = JSON.parse(e.dataTransfer.getData('text/plain')); onDrop(item.id, item.from, f.id); } catch {} }}><button aria-pressed={selected === f.id} onClick={() => onSelect(f.id)}>▱ {titleOf(state, f)}</button>{path.includes(f.id) ? <small>循环位置，停止展开</small> : <FolderTree state={state} folders={folders} parent={f.id} path={[...path, f.id]} selected={selected} onSelect={onSelect} onDrop={onDrop} />}</li>)}</ul>;
}
const CreateWorld = forwardRef<DirtyHandle, { state: WorkspaceState; execute(c: WorkspaceCommand): Promise<WorkspaceState>; onCreated(state: WorkspaceState, id: string): void }>(function CreateWorld({ state, execute, onCreated }, ref) {
  const [name, setName] = useState(''), [idea, setIdea] = useState(''), [file, setFile] = useState<File>(), [busy, setBusy] = useState(false), [error, setError] = useState('');
  useDirtyGuard(ref, () => Boolean(name || idea || file || busy));
  return <form className="wiki-create" aria-label="创建世界表单" onSubmit={async e => { e.preventDefault(); setBusy(true); setError(''); try {
    let source: SourceFile | undefined;
    if (file) { if (file.size > 1_000_000) throw new Error('本阶段每个文件最多1MB。'); source = { name: file.name, mime: file.type || 'application/octet-stream', content: encodeBytes(new Uint8Array(await file.arrayBuffer())) }; }
    const result = newWorld(state, name, idea, source); const next = await execute(result.command); onCreated(next, result.worldId);
  } catch (e) { setError((e as Error).message); } finally { setBusy(false); } }}><h2>从任意起点创建世界</h2><label>世界名称（可稍后填写）<input aria-label="新世界名称" value={name} onChange={e => setName(e.target.value)} /></label><label>一个想法或草案<textarea aria-label="世界初始想法" value={idea} onChange={e => setIdea(e.target.value)} maxLength={100000} /></label><label>已有资料（可选）<input aria-label="创建世界的已有资料" type="file" onChange={e => setFile(e.target.files?.[0])} /></label><p>可以全部留空开始。资料原件进入此世界空间，正文和结构可随时手改，确认创建不要求先填满内容。</p><button className="button-primary" disabled={busy}>保存世界草案</button>{error && <p role="alert" className="inline-error">{error}</p>}</form>;
});
const CreateObject = forwardRef<DirtyHandle, { state: WorkspaceState; worldId: string; kind: 'entry' | 'relation' | 'folder'; folder: string; execute(c: WorkspaceCommand): Promise<WorkspaceState>; onClose(): void; onCreated(state: WorkspaceState, id: string): void }>(function CreateObject({ state, worldId, kind, folder, execute, onClose, onCreated }, ref) {
  const [name, setName] = useState(''), [sources, setSources] = useState<string[]>([]), [targets, setTargets] = useState<string[]>([]), [busy, setBusy] = useState(false), [error, setError] = useState('');
  useDirtyGuard(ref, () => Boolean(name || sources.length || targets.length || busy));
  const endpoints = (label: string, values: string[], set: (v: string[]) => void) => <label>{label}<select multiple aria-label={label} value={values} onChange={e => set([...e.target.selectedOptions].map(o => o.value))}>{state.objects.map(o => <option key={o.id} value={o.id}>{titleOf(state, o)} · {o.id.slice(0, 8)}</option>)}</select></label>;
  return <form className="wiki-create" onSubmit={async e => { e.preventDefault(); setBusy(true); setError(''); try {
    const location = folder !== '*' && folder !== '' ? folder : undefined;
    if (kind === 'folder' && state.objects.some(o => o.worldId === worldId && isFolder(state, o) && titleOf(state, o) === name && (location ? locationsOf(state, o).includes(location) : !locationsOf(state, o).length))) throw new Error('此位置已存在同名文件夹。请改名或取消，不会自动合并或覆盖。');
    const result = newObject(state, worldId, name, kind === 'relation' ? 'relation' : 'entry', sources, targets, kind === 'folder', location);
    const next = await execute(result.command); onCreated(next, result.id);
  } catch (e) { setError((e as Error).message); } finally { setBusy(false); } }}><h3>新建{kind === 'relation' ? '关系' : kind === 'folder' ? '文件夹' : '条目'}</h3><label>名称<input aria-label="新内容名称" value={name} required={kind === 'folder'} onChange={e => setName(e.target.value)} /></label>{kind === 'relation' && <>{endpoints('关系起点（可多选）', sources, setSources)}{endpoints('关系目标（可多选）', targets, setTargets)}</>}<button className="button-primary" disabled={busy}>保存新内容</button><button type="button" onClick={onClose}>取消</button>{error && <p role="alert" className="inline-error">{error}</p>}</form>;
});
