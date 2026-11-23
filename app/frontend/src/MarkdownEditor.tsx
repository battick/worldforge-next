import { forwardRef, useImperativeHandle, useRef } from 'react';
import { Editor, defaultValueCtx, editorStateCtx, remarkStringifyOptionsCtx, rootCtx } from '@milkdown/kit/core';
import type { Node as ProseNode } from '@milkdown/kit/prose/model';
import { commonmark } from '@milkdown/kit/preset/commonmark';
import { gfm } from '@milkdown/kit/preset/gfm';
import { history } from '@milkdown/kit/plugin/history';
import { listener, listenerCtx } from '@milkdown/kit/plugin/listener';
import { getMarkdown } from '@milkdown/kit/utils';
import { Milkdown, MilkdownProvider, useEditor } from '@milkdown/react';

export interface EditorHandle { read(): string; hasUnreportedChanges(): boolean }
interface Props { value: string; onChange(value: string): void }

const Inner = forwardRef<EditorHandle, Props>(function Inner({ value, onChange }, ref) {
  const callback = useRef(onChange);
  const reported = useRef<ProseNode | undefined>(undefined);
  callback.current = onChange;
  const { get } = useEditor(root => Editor.make()
    .config(ctx => {
      ctx.set(rootCtx, root);
      ctx.set(defaultValueCtx, value);
      // Preserve wiki notation only in prose text nodes. Code blocks and
      // inline code keep their own serializers and remain byte-for-byte text.
      ctx.update(remarkStringifyOptionsCtx, options => ({
        ...options,
        handlers: { ...options.handlers, text: (node, parent, state, info) => {
          const original = options.handlers?.text;
          return String(node.value).split(/(\[\[[^\n\[\]]+\]\])/g).map(value => {
            if (/^\[\[[^\n\[\]]+\]\]$/.test(value)) return value;
            return original ? original({ ...node, value }, parent, state, info) : state.safe(value, info);
          }).join('');
        } },
      }));
      ctx.get(listenerCtx).mounted(current => { reported.current = current.get(editorStateCtx).doc; }).markdownUpdated((current, markdown, previous) => {
        reported.current = current.get(editorStateCtx).doc;
        if (markdown !== previous) callback.current(markdown);
      });
    })
    .use(commonmark).use(gfm).use(history).use(listener), []);
  useImperativeHandle(ref, () => ({ read: () => {
    const editor = get();
    return editor ? editor.action(getMarkdown()) : value;
  }, hasUnreportedChanges: () => {
    const current = get();
    return Boolean(current && reported.current && current.action(ctx => !ctx.get(editorStateCtx).doc.eq(reported.current!)));
  } }), [get, value]);
  return <div onClickCapture={event => {
    const anchor = (event.target as HTMLElement).closest('a');
    if (!anchor) return;
    const url = new URL(anchor.href, location.origin);
    if (!['http:', 'https:', 'mailto:'].includes(url.protocol)) event.preventDefault();
  }}><Milkdown /></div>;
});

export const MarkdownEditor = forwardRef<EditorHandle, Props>(function MarkdownEditor(props, ref) {
  return <MilkdownProvider><Inner {...props} ref={ref} /></MilkdownProvider>;
});
