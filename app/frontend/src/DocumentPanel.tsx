import { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { DemoDocument } from '../../contracts/demo.ts';
import { MarkdownEditor, type EditorHandle } from './MarkdownEditor.tsx';
import { api } from './api.ts';

export function DocumentPanel({ document }: { document: DemoDocument }) {
  const [text, setText] = useState(document.markdown);
  const [saved, setSaved] = useState(document);
  const [mode, setMode] = useState<'edit' | 'read' | 'source'>('edit');
  const [generation, setGeneration] = useState(0);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const editor = useRef<EditorHandle>(null);
  const dirty = text !== saved.markdown;
  const state = useRef({ dirty, text });
  state.current = { dirty, text };

  useEffect(() => {
    if (document.version <= saved.version) return;
    // Milkdown's Markdown listener is debounced. Inspect its live document too.
    if (!state.current.dirty && !editor.current?.hasUnreportedChanges()) {
      setText(document.markdown); setSaved(document); setGeneration(n => n + 1);
    }
  }, [document, saved.version]);
  useEffect(() => {
    const guard = (event: BeforeUnloadEvent) => {
      if (state.current.dirty || editor.current?.hasUnreportedChanges()) { event.preventDefault(); event.returnValue = ''; }
    };
    window.addEventListener('beforeunload', guard);
    return () => window.removeEventListener('beforeunload', guard);
  }, []);

  const switchMode = (next: typeof mode) => {
    if (mode === 'edit') setText(editor.current?.read() ?? text);
    setMode(next); setNotice('');
  };
  const save = async () => {
    const markdown = mode === 'edit' ? editor.current?.read() ?? text : text;
    setSaving(true); setError(''); setText(markdown);
    try {
      const result = await api.save(markdown, saved.version);
      setSaved(result); setNotice('已保存到本机');
    } catch (e) { setError((e as Error).message); }
    finally { setSaving(false); }
  };

  return <section className="document-panel" aria-label="正文工作区">
    <header className="document-heading">
      <div><span className="eyebrow">创作纸 / 001</span><h1>雾海来信<span className="title-dot">.</span></h1><p>从一个念头开始，慢慢长成一个世界。</p></div>
      <span className="pill">虚构示例</span>
    </header>
    <div className="document-toolbar">
      <div className="view-switch" aria-label="正文查看方式">
        <button aria-pressed={mode === 'edit'} onClick={() => switchMode('edit')}>编辑</button>
        <button aria-pressed={mode === 'read'} onClick={() => switchMode('read')}>阅读</button>
        <button aria-pressed={mode === 'source'} onClick={() => switchMode('source')}>Markdown 源码</button>
      </div>
      <div className="save-group"><span className={dirty ? 'save-status dirty' : 'save-status'} role="status">{saving ? '正在保存…' : dirty ? '有未保存修改' : notice || '已保存到本机'}</span><button className="button-primary save-button" onClick={save} disabled={saving}>保存正文 <span>↗</span></button></div>
    </div>
    {error && <div className="inline-error" role="alert">{error}</div>}
    {document.version > saved.version && dirty && <div className="inline-error">其他页面保存了新版本。当前文字仍在此处，请先复制保留，再刷新页面。</div>}
    <div className="paper">
      {mode === 'edit' && <MarkdownEditor key={generation} ref={editor} value={text} onChange={value => { setText(value); setNotice(''); }} />}
      {mode === 'source' && <textarea className="source-editor" aria-label="Markdown 源码" spellCheck={false} value={text} onChange={e => { setText(e.target.value); setNotice(''); }} />}
      {mode === 'read' && <article className="markdown-body"><ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml components={{ img: ({ alt }) => <span className="image-placeholder">[图片：{alt || '未命名'}]</span>, a: ({ href, children }) => <a href={href} target="_blank" rel="noreferrer noopener">{children}</a> }}>{text}</ReactMarkdown></article>}
    </div>
    <footer className="paper-footer"><span>MARKDOWN · 本机持久保存</span><span>{text.length.toLocaleString()} 字符 <span className="footer-separator">/</span> 版本 {saved.version}</span></footer>
  </section>;
}
