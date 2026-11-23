import { useEffect, useState } from 'react';
import { useDemoSnapshot } from './hooks/useDemoSnapshot.ts';
import { DocumentPanel } from './DocumentPanel.tsx';
import { AgentPanel } from './AgentPanel.tsx';
import { DataWorkbench } from './DataWorkbench.tsx';

export function App() {
  const { snapshot, connected, error } = useDemoSnapshot();
  const [agentOpen, setAgentOpen] = useState(true);
  const [page, setPage] = useState<'paper' | 'data'>(() => location.hash === '#data' ? 'data' : 'paper');
  const navigate = (next: 'paper' | 'data') => {
    setPage(next);
    location.hash = next;
  };
  useEffect(() => {
    const syncPage = () => setPage(location.hash === '#data' ? 'data' : 'paper');
    window.addEventListener('hashchange', syncPage);
    return () => window.removeEventListener('hashchange', syncPage);
  }, []);
  return <div className="app-shell">
    <aside className="nav-rail">
      <div className="brand"><div className="brand-mark"><svg viewBox="0 0 32 32" fill="none" aria-hidden="true"><path d="M6 10 16 4l10 6v12l-10 6-10-6V10Z M6 10l10 6 10-6 M16 16v12" stroke="currentColor" strokeWidth="1.6" /></svg></div><span>WorldForge<small>世界构建工作台</small></span></div>
      <div className="nav-section-label">工作台</div>
      <button className={page === 'paper' ? 'nav-active' : 'data-nav'} aria-pressed={page === 'paper'} onClick={() => navigate('paper')}><span>▧</span> 创作纸 <span className="nav-number">01</span></button>
      <button className={page === 'data' ? 'nav-active' : 'data-nav'} aria-pressed={page === 'data'} onClick={() => navigate('data')}>统一数据验证</button>
      <div className="nav-subtitle">雾海来信</div>
      <div className="nav-stage"><span className="eyebrow">当前交付</span><strong>02 / 统一数据与修改记录</strong><p>资料共同保存，<br />修改保留依据。</p><div className="stage-pips"><i className="active" /><i className="active" /><i /><i /><i /><i /></div></div>
      <div className="nav-footer"><span className="status-dot" /> 本机工作空间<small>数据保存在你的电脑上</small></div>
    </aside>
    <div className="workspace-shell">
      <header className="topbar"><div className="breadcrumb">工作台 <span>/</span> <strong>{page === 'paper' ? '组件接入演示' : '统一数据验证'}</strong></div><div className="topbar-actions"><button className="agent-toggle" onClick={() => navigate(page === 'paper' ? 'data' : 'paper')}>{page === 'paper' ? '数据验证' : '返回创作纸'}</button><span className={connected ? 'connection' : 'connection offline'}><span className="status-dot" />{connected ? '本机服务已连接' : '服务未连接 · 正在重连'}</span><button className="agent-toggle" aria-pressed={agentOpen} onClick={() => setAgentOpen(open => !open)}>{agentOpen ? '收起助手' : '展开助手'} <span>◧</span></button></div></header>
      <div className="stage-banner"><span className="banner-index">S1.2</span><span>统一字段、多端关系与整体保存验证</span><span className="banner-detail">世界创建与 Wiki 将在后续阶段接入</span></div>
      {!connected && snapshot && <div className="connection-warning" role="status">本机服务连接已断开。未保存文字仍保留在当前页面；重连成功后可继续保存。</div>}
      {snapshot ? <><main hidden={page !== 'paper'} className={`workspace ${!agentOpen ? 'agent-closed' : ''}`}><div className="paper-workspace"><section className="stage-entry" aria-label="阶段入口"><div><span className="eyebrow">已开放的演示</span><h2>S1.2 · 统一数据与修改记录</h2><p>查看字段、关系和修改记录，验证整体保存。</p></div><a className="stage-entry-link" href="#data">进入 S1.2 数据验证 <span aria-hidden="true">→</span></a><p className="stage-next">下一开发阶段 S1.3：手工 Wiki · 尚未开发</p></section><DocumentPanel document={snapshot.document} /></div>{agentOpen && <AgentPanel snapshot={snapshot} connected={connected} />}</main>{page === 'data' && <DataWorkbench />}</> : <main className="loading-state"><div className="welcome-symbol">✳</div><h1>正在打开工作台</h1><p>{error || '正在读取本机保存的内容…'}</p></main>}
    </div>
  </div>;
}
