import { forwardRef, useRef, useState } from 'react';
import type { Resource, WorkspaceCommand, WorkspaceState } from '../../contracts/workspace.ts';
import { command, encodeBytes, encodeText, moveResources, resourceText } from '../../client/wiki.ts';
import { WikiMarkdown } from './WikiMarkdown.tsx';
import { useDirtyGuard, type DirtyHandle } from './hooks/useDirtyGuard.ts';

export const WorldSpace = forwardRef<DirtyHandle, { state: WorkspaceState; worldId: string; execute(c: WorkspaceCommand): Promise<WorkspaceState>; onOpen(id: string): void }>(function WorldSpace({ state, worldId, execute, onOpen }, ref) {
  const [path, setPath] = useState('资料/笔记.md'), [text, setText] = useState(''), [file, setFile] = useState<File>();
  const [current, setCurrent] = useState(''), [version, setVersion] = useState<number>(), [prefix, setPrefix] = useState('');
  const [destination, setDestination] = useState(''), [error, setError] = useState(''), [notice, setNotice] = useState(''), [busy, setBusy] = useState(false);
  const upload = useRef<HTMLInputElement>(null);
  useDirtyGuard(ref, () => Boolean(text || file || busy));
  const resources = state.resources.filter(r => r.worldId === worldId);
  const selected = resources.find(r => r.id === current);
  const content = selected && state.resourceVersions.find(v => v.id === selected.id && v.version === (version ?? selected.version));
  const readable = Boolean(selected && /\.(txt|md|markdown)$/i.test(selected.path));
  let parsed = ''; try { if (selected && readable) parsed = resourceText(state, selected.id, version ?? selected.version); } catch { parsed = '文件已保留原始字节，但不能按支持的文字编码解析。'; }
  const run = async (action: () => Promise<void>) => { setBusy(true); setError(''); setNotice(''); try { await action(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } };
  const choose = (r: Resource) => { setCurrent(r.id); setVersion(r.version); setDestination(r.path); };
  const download = () => {
    if (!content || !selected) return;
    const bytes = Uint8Array.from(atob(content.content), c => c.charCodeAt(0));
    const url = URL.createObjectURL(new Blob([bytes], { type: content.mime }));
    const link = document.createElement('a'); link.href = url; link.download = selected.path.split('/').at(-1)!; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return <section className="world-space"><h2>世界空间</h2><p>资料长期保存在当前世界，不会因上传而自动变成条目或正式设定。TXT、Markdown可阅读，其他格式仅保存原件。</p>
    <form className="wiki-import" onSubmit={e => { e.preventDefault(); void run(async () => {
      if (file && file.size > 1_000_000) throw new Error('本阶段每个文件最多1MB。');
      const payload = file ? encodeBytes(new Uint8Array(await file.arrayBuffer())) : encodeText(text);
      await execute(command(state, worldId, [{ type: 'resource.put', id: crypto.randomUUID(), worldId, path, mime: file?.type || (path.endsWith('.md') ? 'text/markdown' : 'text/plain'), content: payload }]));
      setNotice('原始资料已保存；没有生成或覆盖条目。'); setText(''); setFile(undefined); if (upload.current) upload.current.value = '';
    }); }}>
      <label>保存路径（用 / 嵌套目录）<input aria-label="资料保存路径" value={path} onChange={e => setPath(e.target.value)} required /></label>
      <label>上传文件<input ref={upload} aria-label="上传资料文件" type="file" onChange={e => { const next = e.target.files?.[0]; setFile(next); if (next) { setPath(`资料/${next.name}`); setText(''); } }} /></label>
      <label>或粘贴文字<textarea aria-label="粘贴资料文字" value={text} onChange={e => { setText(e.target.value); setFile(undefined); if (upload.current) upload.current.value = ''; }} /></label>
      <button className="button-primary" disabled={busy || (!file && !text)}>保存资料</button>
    </form>
    <label>查看目录<input aria-label="空间目录筛选" placeholder="例如 资料/人物" value={prefix} onChange={e => setPrefix(e.target.value)} /></label>
    <div className="wiki-file-grid"><div className="wiki-file-list">{resources.filter(r => !prefix || r.path === prefix || r.path.startsWith(prefix.replace(/\/$/, '') + '/')).sort((a, b) => a.path.localeCompare(b.path, 'zh-CN')).map(r => <button key={r.id} aria-pressed={r.id === current} onClick={() => choose(r)}>{r.path}<small>版本 {r.version}</small></button>)}{!resources.length && <p>空间还没有文件。</p>}</div>
    <div>{selected && <><h3>{selected.path}</h3><label>内容版本<select aria-label="资料内容版本" value={version ?? selected.version} onChange={e => setVersion(Number(e.target.value))}>{state.resourceVersions.filter(v => v.id === selected.id).map(v => <option key={v.version} value={v.version}>版本 {v.version}</option>)}</select></label><button onClick={download}>下载原件</button>
      {readable ? selected.path.toLowerCase().endsWith('.txt') ? <pre className="wiki-source-preview">{parsed}</pre> : <WikiMarkdown text={parsed} state={state} onOpen={onOpen} /> : <p className="wiki-note">已保存原件；本阶段不解析此格式。可以下载原件查看。</p>}
      <div className="wiki-file-operations"><label>目标文件路径<input aria-label="文件目标路径" value={destination} onChange={e => setDestination(e.target.value)} /></label><button disabled={busy} onClick={() => run(async () => { await execute(moveResources(state, worldId, selected.path, destination)); setNotice('文件已移动，身份与历史内容保留。'); })}>移动或改名</button><button disabled={busy} onClick={() => run(async () => { await execute(moveResources(state, worldId, selected.path, destination, true)); setNotice('已另存一份文件，原文件保留。'); })}>复制文件</button><button disabled={busy} onClick={() => { if (window.confirm('删除这个文件？仍被字段引用时会拒绝，旧内容版本保留在历史中。')) void run(async () => { await execute(command(state, worldId, [{ type: 'resource.delete', id: selected.id }])); setCurrent(''); }); }}>删除文件</button></div>
    </>}</div></div>
    <details><summary>整体移动或复制目录中的文件</summary><label>原目录<input aria-label="空间原目录" value={prefix} onChange={e => setPrefix(e.target.value)} /></label><label>目标目录<input aria-label="空间目标目录" value={destination} onChange={e => setDestination(e.target.value)} /></label><button disabled={busy || !prefix} onClick={() => run(async () => { await execute(moveResources(state, worldId, prefix, destination)); setNotice('目录中的文件已一起移动。'); })}>移动目录文件</button><button disabled={busy || !prefix} onClick={() => run(async () => { await execute(moveResources(state, worldId, prefix, destination, true)); setNotice('目录中的文件已一起复制，原件保留。'); })}>复制目录文件</button></details>
    {error && <p role="alert" className="inline-error">未保存：{error}</p>}<p role="status">{notice}</p>
  </section>;
});
