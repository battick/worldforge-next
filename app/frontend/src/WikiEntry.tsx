import { forwardRef, useEffect, useRef, useState } from 'react';
import type { ContentObject, WorkspaceCommand, WorkspaceState } from '../../contracts/workspace.ts';
import { isFolder, locationsOf, saveEntry, titleOf } from '../../client/wiki.ts';
import { WikiDocument, type DocumentHandle } from './WikiDocument.tsx';
import { WikiFields, writableFields, decodeFields } from './WikiFields.tsx';
import { useDirtyGuard, type DirtyHandle } from './hooks/useDirtyGuard.ts';
import type { OpenEntry } from './WikiMarkdown.tsx';

export const WikiEntry = forwardRef<DirtyHandle, { object: ContentObject; state: WorkspaceState; execute(c: WorkspaceCommand): Promise<WorkspaceState>; onOpen: OpenEntry }>(function WikiEntry({ object, state, execute, onOpen }, ref) {
  const [base, setBase] = useState(state), [fields, setFields] = useState(() => writableFields(state, object));
  const [editing, setEditing] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState(''), [generation, setGeneration] = useState(0);
  const document = useRef<DocumentHandle>(null);
  const original = base.objects.find(o => o.id === object.id)!;
  const dirty = () => busy || JSON.stringify(fields) !== JSON.stringify(writableFields(base, original)) || Boolean(document.current?.dirty());
  useDirtyGuard(ref, dirty);
  const reset = (next: WorkspaceState) => { setBase(next); setFields(writableFields(next, next.objects.find(o => o.id === object.id)!)); setGeneration(n => n + 1); };
  useEffect(() => { if (!editing && !busy) reset(state); }, [state.revision]);
  const begin = () => { if (!editing) { setEditing(true); setError(''); setNotice(''); } };
  return <section className="wiki-entry-editor" aria-label="条目阅读与编辑">
    <div className="wiki-toolbar"><button aria-pressed={!editing} onClick={() => { if (!dirty() || window.confirm('此条目有未保存修改，确定放弃并返回阅读吗？')) { reset(state); setEditing(false); setError(''); } }} disabled={busy}>阅读条目</button><button aria-pressed={editing} onClick={begin} disabled={busy}>编辑条目</button>
      {editing && <><button className="button-primary" disabled={busy} onClick={async () => {
        const bodies = document.current?.collect() ?? [];
        setBusy(true); setError(''); setNotice('');
        try {
          const encoded = decodeFields(base, fields), candidate = { ...original, fields: { ...Object.fromEntries(Object.entries(original.fields).filter(([id]) => id.startsWith('sys.'))), ...encoded } };
          if (isFolder(base, candidate) && base.objects.some(o => o.id !== object.id && o.worldId === object.worldId && isFolder(base, o) && titleOf(base, o) === titleOf(base, candidate) && (locationsOf(base, candidate).length ? locationsOf(base, candidate).some(id => locationsOf(base, o).includes(id)) : !locationsOf(base, o).length))) throw new Error('此位置已有同名文件夹，请改名或取消，不会自动合并。');
          const next = await execute(saveEntry(base, original, encoded, bodies)); reset(next); setEditing(false); setNotice('条目已保存，正文和字段一起生效');
        } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
      }}>{busy ? '正在保存…' : '保存条目'}</button><button disabled={busy} onClick={() => { if (!dirty() || window.confirm('放弃此条目尚未保存的正文和字段修改？')) { reset(state); setEditing(false); setError(''); } }}>取消编辑</button></>}
    </div>
    {editing && <p className="wiki-note">正文和字段共同保存。切换正文显示方式不会丢掉草稿。</p>}
    {editing && base.revision !== state.revision && <p className="wiki-note">资料版本已变化；本地输入保留，保存时会核对冲突。</p>}
    {error && <p role="alert" className="inline-error">未保存：{error} 正文和字段输入均已保留。版本冲突时请先复制本地内容，再重新读取。</p>}
    <p role="status">{busy ? '正在保存' : notice}</p>
    <div inert={busy}>
      <WikiDocument key={generation} ref={document} state={base} object={{ ...original, fields: { ...original.fields, ...Object.fromEntries(Object.entries(fields).filter(([id]) => base.definitions.find(d => d.id === id)?.type !== 'json')) } }} editing={editing} onEdit={begin} onOpen={onOpen} />
      <WikiFields state={base} object={original} fields={fields} setFields={setFields} editing={editing} />
    </div>
  </section>;
});
