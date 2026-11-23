import { useDataWorkbench } from './hooks/useDataWorkbench.ts';

export function DataWorkbench() {
  const { view, example, last, message, busy, seed, convert, replay, reload } = useDataWorkbench();
  return <section className="data-workbench">
    <span className="eyebrow">S1.2 · 统一数据与修改记录</span><h1>数据验证台</h1>
    <p>用虚构资料检查共享字段、多端关系、整体保存与操作去重。手工创建和编辑请进入“世界与 Wiki”。</p>
    <div className="data-actions"><button onClick={seed} disabled={busy}>新增一组验证资料</button><button onClick={() => convert(false)} disabled={busy || !example}>尝试不完整转换</button><button onClick={() => convert(true)} disabled={busy || !example}>一起转换定义和值</button><button onClick={replay} disabled={busy || !last}>重复上次请求</button><button onClick={reload} disabled={busy}>重新读取</button></div>
    <p className="data-message" role="status">{busy ? '正在校验并保存…' : message}</p>
    {view && <>
      <div className="data-summary">版本 {view.state.revision} · {view.state.worlds.length} 个世界 · {view.state.objects.length} 个对象 · {view.history.length} 次修改</div>
      <h2>字段定义</h2><div className="data-scroll"><table><thead><tr><th>名称</th><th>归属</th><th>值类型</th><th>用途标记</th><th>定义版本</th></tr></thead><tbody>{view.state.definitions.map(d => <tr key={d.id}><td>{d.name}</td><td>{d.scope === 'global' ? '全局共用' : '当前世界'}</td><td>{d.type}</td><td>{d.marks.join('、')}</td><td>{d.version}</td></tr>)}</tbody></table></div>
      <h2>对象和字段值</h2>{view.state.objects.map(object => <details key={object.id}><summary>{view.state.definitions.filter(d => d.marks.includes('title')).flatMap(d => object.fields[d.id] ?? []).join(' / ') || '世界根对象'} <small>{object.id}</small></summary><dl>{Object.entries(object.fields).map(([id, values]) => <div key={id}><dt>{view.state.definitions.find(d => d.id === id)?.name}</dt><dd>{JSON.stringify(values)}</dd></div>)}</dl></details>)}
      <h2>修改记录</h2>{view.history.map(record => <details key={record.operationId}><summary>版本 {record.revision} · {record.changes.length} 项改变 <small>{record.createdAt}</small></summary><pre>{JSON.stringify(record, null, 2)}</pre></details>)}
      <p>每次记录保留实际修改前后内容。资源版本独立保留；此处尚未提供业务回滚按钮。</p>
    </>}
  </section>;
}
