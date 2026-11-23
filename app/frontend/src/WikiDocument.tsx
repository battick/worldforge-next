import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import type { ContentObject, WorkspaceCommand, WorkspaceState } from '../../contracts/workspace.ts';
import { bodyRefs, resourceText, saveBody, titleOf } from '../../client/wiki.ts';
import { MarkdownEditor, type EditorHandle } from './MarkdownEditor.tsx';
import { WikiMarkdown } from './WikiMarkdown.tsx';

export interface DirtyHandle { dirty(): boolean }
export const WikiDocument = forwardRef<DirtyHandle, { object: ContentObject; state: WorkspaceState; execute(command: WorkspaceCommand): Promise<WorkspaceState>; onOpen(id: string): void }>(function WikiDocument({ object, state, execute, onOpen }, ref) {
  const refs = bodyRefs(state, object);
  const [selected, setSelected] = useState(refs[0] ? `${refs[0].fieldId}:${refs[0].resource}` : '');
  const chosen = refs.find(r => `${r.fieldId}:${r.resource}` === selected);
  let readError = '';
  const read = () => { try {
    if (!chosen) return '';
    const resource = state.resources.find(r => r.id === chosen.resource), version = state.resourceVersions.find(v => v.id === chosen.resource && v.version === chosen.version);
    if (!resource || !version || !(version.mime.startsWith('text/') || /\.(md|markdown|txt)$/i.test(resource.path))) throw new Error('该正文资源不是本阶段可编辑的文字格式。');
    return resourceText(state, chosen.resource, chosen.version);
  } catch (e) { readError = (e as Error).message; return ''; } };
  read();
  const [text, setText] = useState(read), [saved, setSaved] = useState(read), [base, setBase] = useState(state);
  const [mode, setMode] = useState<'read' | 'edit' | 'source'>('read');
  const [error, setError] = useState(''), [notice, setNotice] = useState(''), [busy, setBusy] = useState(false);
  const [generation, setGeneration] = useState(0), [linkId, setLinkId] = useState('');
  const editor = useRef<EditorHandle>(null);
  const live = useRef({ text, saved }); live.current = { text, saved };
  const dirty = () => live.current.text !== live.current.saved || Boolean(editor.current?.hasUnreportedChanges());
  useImperativeHandle(ref, () => ({ dirty }));
  useEffect(() => {
    if (!dirty() && refs.length && !chosen) { setSelected(`${refs[0]!.fieldId}:${refs[0]!.resource}`); return; }
    if (!dirty()) { const next = read(); setText(next); setSaved(next); setBase(state); setGeneration(n => n + 1); }
  }, [state.revision, selected]);
  useEffect(() => {
    const guard = (e: BeforeUnloadEvent) => { if (dirty()) { e.preventDefault(); e.returnValue = ''; } };
    window.addEventListener('beforeunload', guard); return () => window.removeEventListener('beforeunload', guard);
  }, []);
  const changeMode = (next: typeof mode) => { if (mode === 'edit') setText(editor.current?.read() ?? text); setMode(next); };
  const save = async () => {
    const next = mode === 'edit' ? editor.current?.read() ?? text : text;
    setText(next); setBusy(true); setError(''); setNotice('');
    try {
      const original = base.objects.find(o => o.id === object.id)!;
      const request = saveBody(base, original, next, chosen?.fieldId, chosen?.resource);
      const latest = await execute(request);
      setBase(latest);
      const changed = request.changes.find(c => c.type === 'resource.put');
      const nextRef = bodyRefs(latest, latest.objects.find(o => o.id === object.id)!).find(r => changed && r.resource === changed.id);
      if (nextRef) setSelected(`${nextRef.fieldId}:${nextRef.resource}`);
      setSaved(next); setNotice('正文已保存');
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };
  const select = (value: string) => {
    if (dirty() && !window.confirm('当前正文尚未保存。确定切换并放弃这些文字吗？')) return;
    setSelected(value); setText(''); setSaved(''); setError(''); setNotice('');
  };
  return <section className="wiki-document" aria-label="条目正文">
    <div className="wiki-toolbar">
      <div className="view-tabs"><button aria-pressed={mode === 'read'} onClick={() => changeMode('read')}>阅读正文</button><button aria-pressed={mode === 'edit'} onClick={() => changeMode('edit')}>编辑正文</button><button aria-pressed={mode === 'source'} onClick={() => changeMode('source')}>正文源码</button></div>
      <button className="button-primary" onClick={save} disabled={busy || Boolean(readError)}>{busy ? '正在保存…' : '保存条目正文'}</button>
    </div>
    {refs.length > 1 && <label>正文资源<select aria-label="选择正文资源" value={selected} onChange={e => select(e.target.value)}>{refs.map(r => <option key={`${r.fieldId}:${r.resource}`} value={`${r.fieldId}:${r.resource}`}>{r.fieldName} · {r.resource.slice(0, 8)}</option>)}</select></label>}
    {!refs.length && <p className="wiki-note">还没有正文。填写并保存时会添加正文资源和相应字段。</p>}
    {readError && <p className="inline-error" role="alert">{readError} 原件和字段引用仍保留，可在世界空间查看或下载。</p>}
    {mode !== 'read' && <div className="wiki-link-insert"><select aria-label="插入双链目标" value={linkId} onChange={e => setLinkId(e.target.value)}><option value="">选择已有条目</option>{state.objects.filter(o => o.id !== object.id).map(o => <option key={o.id} value={o.id}>{titleOf(state, o)}</option>)}</select><button disabled={!linkId} onClick={() => {
      const current = mode === 'edit' ? editor.current?.read() ?? text : text;
      const target = state.objects.find(o => o.id === linkId)!;
      setText(current + `\n[[${target.id}|${titleOf(state, target).replace(/[\[\]|\n]/g, '')}]]`); setGeneration(n => n + 1);
    }}>插入条目引用</button></div>}
    {error && <p role="alert" className="inline-error">未保存：{error} 当前文字保留。版本冲突时请先复制本地内容，再重新读取。</p>}
    <p role="status" className="wiki-note">{busy ? '正在保存' : text !== saved ? '正文有未保存修改' : notice}</p>
    <div className="wiki-paper">{mode === 'read' ? <WikiMarkdown text={text} state={state} onOpen={onOpen} /> : mode === 'source' ? <textarea className="source-editor" aria-label="条目Markdown源码" value={text} onChange={e => setText(e.target.value)} /> : <MarkdownEditor key={generation} ref={editor} value={text} onChange={setText} />}</div>
  </section>;
});
