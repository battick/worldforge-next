import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { WorkspaceState } from '../../contracts/workspace.ts';
import { bodyRefs, resourceText, titleOf } from '../../client/wiki.ts';

export type OpenEntry = (id: string, newTab?: boolean) => void;
export const WikiPreviewContext = createContext<((id: string) => void) | undefined>(undefined);
function excerpt(state: WorkspaceState, id: string) {
  const object = state.objects.find(o => o.id === id), body = object && bodyRefs(state, object)[0];
  try { return body ? resourceText(state, body.resource, body.version) : '还没有正文，可打开查看字段。'; }
  catch { return '正文资源暂不可读，可打开查看字段或下载原件。'; }
}
function WikiLink({ id, state, onOpen, children }: { id: string; state: WorkspaceState; onOpen: OpenEntry; children: ReactNode }) {
  const [hover, setHover] = useState(false), anchor = useRef<HTMLButtonElement>(null), card = useRef<HTMLElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined), pin = useContext(WikiPreviewContext);
  const keep = () => { clearTimeout(timer.current); setHover(true); };
  const leave = () => { clearTimeout(timer.current); timer.current = setTimeout(() => setHover(false), 250); };
  useEffect(() => () => clearTimeout(timer.current), []);
  useLayoutEffect(() => {
    if (!hover || !anchor.current || !card.current) return;
    const rect = anchor.current.getBoundingClientRect(), popup = card.current;
    popup.style.left = `${Math.max(12, Math.min(rect.left, innerWidth - popup.offsetWidth - 12))}px`;
    popup.style.top = `${Math.max(12, rect.bottom + popup.offsetHeight + 20 < innerHeight ? rect.bottom + 8 : rect.top - popup.offsetHeight - 8)}px`;
  }, [hover]);
  const object = state.objects.find(o => o.id === id)!;
  return <><button ref={anchor} type="button" className="wiki-inline-link" title={titleOf(state, object)} onMouseEnter={keep} onMouseLeave={leave} onFocus={keep} onBlur={leave} onClick={e => { setHover(false); onOpen(id, e.ctrlKey || e.metaKey); }} onPointerDown={e => { if (e.button === 1) { e.preventDefault(); setHover(false); onOpen(id, true); } }} onAuxClick={e => { if (e.button === 1) e.preventDefault(); }}>{children}</button>
    {hover && createPortal(<aside ref={card} className="wiki-hover-preview" aria-label="条目悬停预览" onMouseEnter={keep} onMouseLeave={leave} onFocus={keep} onBlur={leave} onKeyDown={e => { if (e.key === 'Escape') setHover(false); }}><div className="wiki-preview-heading"><button onClick={() => { setHover(false); onOpen(id); }}>{titleOf(state, object)}</button>{pin && <button onClick={() => { pin(id); setHover(false); }}>固定预览</button>}</div><WikiMarkdown text={excerpt(state, id)} state={state} onOpen={onOpen} /></aside>, document.body)}
  </>;
}
export function WikiPreviewCard({ id, index, state, onOpen, onClose }: { id: string; index: number; state: WorkspaceState; onOpen: OpenEntry; onClose(): void }) {
  const card = useRef<HTMLElement>(null), drag = useRef<{ x: number; y: number; left: number; top: number } | undefined>(undefined);
  useLayoutEffect(() => {
    if (!card.current) return;
    card.current.style.left = `${Math.max(12, innerWidth - card.current.offsetWidth - 24 - index * 26)}px`;
    card.current.style.top = `${Math.min(100 + index * 30, Math.max(12, innerHeight - card.current.offsetHeight - 12))}px`;
  }, []);
  const object = state.objects.find(o => o.id === id); if (!object) return null;
  return <aside ref={card} aria-label={`固定预览${titleOf(state, object)}`}><div className="wiki-preview-heading" aria-label="拖动预览" onPointerDown={e => {
    if ((e.target as Element).closest('button') || e.button !== 0 || !card.current) return;
    const rect = card.current.getBoundingClientRect(); drag.current = { x: e.clientX, y: e.clientY, left: rect.left, top: rect.top }; e.currentTarget.setPointerCapture(e.pointerId);
  }} onPointerMove={e => {
    if (!drag.current || !card.current) return;
    card.current.style.left = `${Math.max(0, Math.min(innerWidth - card.current.offsetWidth, drag.current.left + e.clientX - drag.current.x))}px`;
    card.current.style.top = `${Math.max(0, Math.min(innerHeight - 50, drag.current.top + e.clientY - drag.current.y))}px`;
  }} onPointerUp={() => { drag.current = undefined; }} onPointerCancel={() => { drag.current = undefined; }}><span>拖动</span><button onClick={() => onOpen(id)}>{titleOf(state, object)}</button><button aria-label={`取消预览${titleOf(state, object)}`} onClick={onClose}>×</button></div><WikiMarkdown text={excerpt(state, id)} state={state} onOpen={onOpen} /></aside>;
}

interface Node { type: string; value?: string; url?: string; children?: Node[] }
function wikiLinks() {
  return (tree: unknown) => {
    const walk = (node: Node) => {
      if (!node.children || ['link', 'code', 'inlineCode', 'image'].includes(node.type)) return;
      node.children = node.children.flatMap(child => {
        if (child.type !== 'text' || !child.value) { walk(child); return [child]; }
        const output: Node[] = []; let last = 0;
        for (const match of child.value.matchAll(/\[\[([^\n\[\]|]+)(?:\|([^\n\[\]]+))?\]\]/g)) {
          if (match.index! > last) output.push({ type: 'text', value: child.value.slice(last, match.index) });
          output.push({ type: 'link', url: `#entry/${encodeURIComponent(match[1]!)}`, children: [{ type: 'text', value: match[2] || match[1] }] });
          last = match.index! + match[0].length;
        }
        if (last < child.value.length) output.push({ type: 'text', value: child.value.slice(last) });
        return output.length ? output : [child];
      });
    };
    walk(tree as Node);
  };
}
export function WikiMarkdown({ text, state, onOpen }: { text: string; state: WorkspaceState; onOpen: OpenEntry }) {
  return <article className="markdown-body wiki-markdown"><ReactMarkdown remarkPlugins={[remarkGfm, wikiLinks]} skipHtml components={{
    img: ({ alt }) => <span className="image-placeholder">[图片：{alt || '未命名'}]</span>,
    a: ({ href, children }) => {
      if (href?.startsWith('#entry/')) {
        let id: string; try { id = decodeURIComponent(href.slice(7)); } catch { return <span className="wiki-missing-link">{children}（引用格式无效）</span>; }
        const target = state.objects.find(o => o.id === id);
        return target ? <WikiLink id={id} state={state} onOpen={onOpen}>{children}</WikiLink>
          : <span className="wiki-missing-link" title="引用目标不存在；不会自动创建条目">{children}（缺失）</span>;
      }
      return <a href={href} target="_blank" rel="noreferrer noopener">{children}</a>;
    },
  }}>{text}</ReactMarkdown></article>;
}
