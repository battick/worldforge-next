import { useEffect, useState } from 'react';
import type { WorkspaceCommand, WorkspaceView as View } from '../../../contracts/workspace.ts';
import { api } from '../api.ts';

export function useDataWorkbench() {
  const [view, setView] = useState<View>();
  const [example, setExample] = useState<{ ids: Record<string, string>; command: WorkspaceCommand }>();
  const [last, setLast] = useState<WorkspaceCommand>();
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const load = async () => setView(await api.workspace());
  useEffect(() => { load().catch(error => setMessage(error.message)); }, []);
  const run = async (action: () => Promise<void>) => {
    setBusy(true); setMessage('');
    try { await action(); } catch (error) { setMessage(`未保存：${(error as Error).message}`); }
    finally { await load().catch(error => setMessage(error.message)); setBusy(false); }
  };
  const seed = () => run(async () => {
    const result = await api.example();
    setExample(result); setLast(result.command); setMessage('已保存两个世界、共享字段、多端关系和一份正文资源。');
  });
  const convert = (complete: boolean) => run(async () => {
    if (!view || !example) return;
    const { version: _v, ...definition } = view.state.definitions.find(d => d.id === example.ids.score)!;
    const command: WorkspaceCommand = { operationId: crypto.randomUUID(), baseRevision: view.state.revision, changes: [
      { type: 'definition.put', definition: { ...definition, type: definition.type === 'number' ? 'text' : 'number' } },
      ...(complete ? view.state.objects.filter(o => o.fields[definition.id]).map(o => ({ type: 'object.update' as const, id: o.id, set: { [definition.id]: o.fields[definition.id]!.map(v => definition.type === 'number' ? String(v) : Number(v)) } })) : []),
    ] };
    const result = await api.execute(command);
    setLast(command); setMessage(`定义和两个世界的值已一起保存，版本 ${result.revision}。`);
  });
  const replay = () => run(async () => {
    if (!last) return;
    const result = await api.execute(last);
    setMessage(`重复请求返回原操作版本 ${result.revision}，没有新增修改记录。`);
  });
  return { view, example, last, message, busy, seed, convert, replay, reload: () => run(load) };
}
