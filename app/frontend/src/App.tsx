import { useEffect, useState } from 'react';
import { useDemoSnapshot } from './hooks/useDemoSnapshot.ts';
import { DocumentPanel } from './DocumentPanel.tsx';
import { AgentPanel } from './AgentPanel.tsx';
import { DataWorkbench } from './DataWorkbench.tsx';
import { WikiWorkbench } from './WikiWorkbench.tsx';
import { CollaborationPanel } from './CollaborationPanel.tsx';
import { useWebUpdate } from './hooks/useWebUpdate.ts';

const readPage = () => location.hash === '#paper' ? 'paper' : location.hash === '#data' ? 'data' : 'wiki';

export function App() {
  const { snapshot, connected, error } = useDemoSnapshot();
  const updateAvailable = useWebUpdate();
  const [collaborationOpen, setCollaborationOpen] = useState(false);
  const [agentOpen, setAgentOpen] = useState(true);
  const [page, setPage] = useState<'paper' | 'data' | 'wiki'>(readPage);
  const navigate = (next: 'paper' | 'data' | 'wiki') => {
    setPage(next);
    location.hash = next;
  };
  useEffect(() => {
    const syncPage = () => setPage(readPage());
    window.addEventListener('hashchange', syncPage);
    return () => window.removeEventListener('hashchange', syncPage);
  }, []);
  return <div className="app-shell">
    <aside className="nav-rail">
      <div className="brand"><div className="brand-mark"><svg viewBox="0 0 32 32" fill="none" aria-hidden="true"><path d="M6 10 16 4l10 6v12l-10 6-10-6V10Z M6 10l10 6 10-6 M16 16v12" stroke="currentColor" strokeWidth="1.6" /></svg></div><span>WorldForge<small>世界构建工作台</small></span></div>
      <div className="nav-section-label">工作台</div>
      <button className={page === 'paper' ? 'nav-active' : 'data-nav'} aria-pressed={page === 'paper'} onClick={() => navigate('paper')}><span>▧</span> 创作纸 <span className="nav-number">01</span></button>
      <button className={page === 'data' ? 'nav-active' : 'data-nav'} aria-pressed={page === 'data'} onClick={() => navigate('data')}>统一数据验证</button>
      <button className={page === 'wiki' ? 'nav-active' : 'data-nav'} aria-pressed={page === 'wiki'} onClick={() => navigate('wiki')}>世界与 Wiki</button><div className="nav-subtitle">雾海来信</div>
      <div className="nav-stage"><span className="eyebrow">当前交付</span><strong>03 / 手工世界与 Wiki</strong><p>整理条目和资料，<br />修改保留依据。</p><div className="stage-pips"><i className="active" /><i className="active" /><i className="active" /><i /><i /><i /></div></div>
      <div className="nav-footer"><span className="status-dot" /> 本机工作空间<small>数据保存在你的电脑上</small></div>
    </aside>
    <div className="workspace-shell">
      <header className="topbar"><div className="breadcrumb">工作台 <span>/</span> <strong>{page === 'wiki' ? '世界与 Wiki' : page === 'paper' ? '组件接入演示' : '统一数据验证'}</strong></div><div className="topbar-actions"><button className="agent-toggle" onClick={() => navigate(page === 'paper' ? 'data' : 'paper')}>{page === 'paper' ? '数据验证' : '返回创作纸'}</button><span className={connected ? 'connection' : 'connection offline'}><span className="status-dot" />{connected ? '本机服务已连接' : '服务未连接 · 正在重连'}</span>{page === 'paper' && <button className="agent-toggle" aria-pressed={agentOpen} onClick={() => setAgentOpen(open => !open)}>{agentOpen ? '收起助手' : '展开助手'} <span>◧</span></button>}</div></header>
      <div className="collaboration-entry"><button onClick={() => setCollaborationOpen(true)}>协作设置与任务</button></div>
      <nav className="workspace-navigation" aria-label="主要功能"><a href="#wiki" aria-current={page === 'wiki' ? 'page' : undefined}>我的世界 / Wiki</a><a href="#data" aria-current={page === 'data' ? 'page' : undefined}>数据验证</a><a href="#paper" aria-current={page === 'paper' ? 'page' : undefined}>创作纸演示</a></nav>
      {collaborationOpen && <CollaborationPanel onClose={() => setCollaborationOpen(false)} />}
      {updateAvailable && <div className="web-update" role="status"><span>页面已有新版本。请先保存正在编辑的内容，再刷新以使用新功能。</span><button onClick={() => location.reload()}>刷新使用新版</button></div>}
      <div className="stage-banner"><span className="banner-index">S1.3</span><span>手工世界、Wiki 与空间资料</span><span className="banner-detail">非空文件夹删除待确认，演示聊天仍为固定回复</span></div>
      {!connected && snapshot && <div className="connection-warning" role="status">本机服务连接已断开。未保存文字仍保留在当前页面；重连成功后可继续保存。</div>}
      <main hidden={page !== 'paper'} className={`workspace ${!agentOpen ? 'agent-closed' : ''}`}>{snapshot ? <><div className="paper-workspace"><section className="stage-entry" aria-label="阶段入口"><div><span className="eyebrow">组件演示与数据检查</span><h2>创作纸演示</h2><p>编辑器和演示聊天保留在这里，真实世界在“我的世界 / Wiki”。</p></div><a className="stage-entry-link" href="#wiki">进入手工 Wiki <span aria-hidden="true">→</span></a><a className="stage-entry-link" href="#data">进入 S1.2 数据验证 <span aria-hidden="true">→</span></a></section><DocumentPanel document={snapshot.document} /></div>{agentOpen && <AgentPanel snapshot={snapshot} connected={connected} />}</> : <div className="loading-state"><h1>正在打开创作纸</h1><p>{error || '正在读取本机保存的演示内容…'}</p></div>}</main>
      {page === 'data' && <DataWorkbench />}
      <main hidden={page !== 'wiki'}><WikiWorkbench /></main>
    </div>
  </div>;
}
