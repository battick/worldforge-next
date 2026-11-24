import { forwardRef, useImperativeHandle, useRef, useState } from 'react';
import type { ContentObject, WorkspaceState } from '../../contracts/workspace.ts';
import { bodyRefs, resourceText, titleOf, type BodyDraft } from '../../client/wiki.ts';
import { MarkdownEditor, type EditorHandle } from './MarkdownEditor.tsx';
import { WikiMarkdown, type OpenEntry } from './WikiMarkdown.tsx';
import type { DirtyHandle } from './hooks/useDirtyGuard.ts';
export interface DocumentHandle extends DirtyHandle { collect(): BodyDraft[] }

export const WikiDocument = forwardRef<DocumentHandle, { object: ContentObject; state: WorkspaceState; editing: boolean; onEdit(): void; onOpen: OpenEntry }>(function WikiDocument({ object, state, editing, onEdit, onOpen }, ref) {
  const refs = bodyRefs(state, object);
  const [selected, setSelected] = useState(refs[0] ? `${refs[0].fieldId}:${refs[0].resource}` : 'new');
  const drafts = useRef(new Map<string, BodyDraft & { original: string }>());
  const active = refs.some(r => `${r.fieldId}:${r.resource}` === selected) || drafts.current.has(selected) ? selected : refs[0] ? `${refs[0].fieldId}:${refs[0].resource}` : 'new';
  const chosen = refs.find(r => `${r.fieldId}:${r.resource}` === active);
  const [, update] = useState(0), [generation, setGeneration] = useState(0), [linkId, setLinkId] = useState('');
  const [mode, setMode] = useState<'read' | 'edit' | 'source'>('read');
  const editor = useRef<EditorHandle>(null);
  let readError = '', original = '';
  try {
    if (chosen) {
      const resource = state.resources.find(r => r.id === chosen.resource), version = state.resourceVersions.find(v => v.id === chosen.resource && v.version === chosen.version);
      if (!resource || !version || !(version.mime.startsWith('text/') || /\.(md|markdown|txt)$/i.test(resource.path))) throw new Error('该正文不是本阶段可编辑的文字格式，原件和引用仍保留。');
      original = resourceText(state, chosen.resource, chosen.version);
    }
  } catch (e) { readError = (e as Error).message; }
  const text = drafts.current.get(active)?.text ?? original;
  const store = (next: string) => {
    const old = drafts.current.get(active);
    drafts.current.set(active, { text: next, original: old?.original ?? original, fieldId: chosen?.fieldId, resourceId: chosen?.resource }); update(n => n + 1);
  };
  const flush = () => { if (editing && mode === 'edit') store(editor.current?.read() ?? text); };
  useImperativeHandle(ref, () => ({
    dirty: () => [...drafts.current.values()].some(d => d.text !== d.original) || Boolean(editor.current?.hasUnreportedChanges()),
    collect: () => { flush(); return [...drafts.current.values()].filter(d => d.text !== d.original).map(({ original: _o, ...draft }) => draft); },
  }));
  const changeMode = (next: typeof mode) => { flush(); if (next !== 'read') onEdit(); setMode(next); };
  return <section className="wiki-document" aria-label="条目正文">
    <div className="wiki-toolbar"><div className="view-tabs"><button aria-pressed={mode === 'read' || !editing} onClick={() => changeMode('read')}>阅读正文</button><button disabled={Boolean(readError)} aria-pressed={editing && mode === 'edit'} onClick={() => changeMode('edit')}>编辑正文</button><button disabled={Boolean(readError)} aria-pressed={editing && mode === 'source'} onClick={() => changeMode('source')}>正文源码</button></div></div>
    {refs.length > 1 && <label>正文资源<select aria-label="选择正文资源" value={active} onChange={e => { flush(); setSelected(e.target.value); setGeneration(n => n + 1); }}>{refs.map(r => <option key={`${r.fieldId}:${r.resource}`} value={`${r.fieldId}:${r.resource}`}>{r.fieldName} · {r.resource.slice(0, 8)}</option>)}</select></label>}
    {!refs.length && <p className="wiki-note">还没有正文。编辑并保存条目时会一同添加。</p>}
    {readError && <p className="inline-error" role="alert">{readError}</p>}
    {editing && mode !== 'read' && <div className="wiki-link-insert"><select aria-label="插入双链目标" value={linkId} onChange={e => setLinkId(e.target.value)}><option value="">选择已有条目</option>{state.objects.filter(o => o.id !== object.id).map(o => <option key={o.id} value={o.id}>{titleOf(state, o)}</option>)}</select><button disabled={!linkId} onClick={() => {
      const current = mode === 'edit' ? editor.current?.read() ?? text : text, target = state.objects.find(o => o.id === linkId)!;
      store(current + `\n[[${target.id}|${titleOf(state, target).replace(/[\[\]|\n]/g, '')}]]`); setGeneration(n => n + 1);
    }}>插入条目引用</button></div>}
    <div className="wiki-paper">{!editing || mode === 'read' ? <WikiMarkdown text={text} state={state} onOpen={onOpen} /> : mode === 'source' ? <textarea className="source-editor" aria-label="条目Markdown源码" value={text} onChange={e => store(e.target.value)} /> : <MarkdownEditor key={`${active}:${generation}`} ref={editor} value={text} onChange={store} />}</div>
  </section>;
});
