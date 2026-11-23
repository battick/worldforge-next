import { useState } from 'react';
import { AssistantRuntimeProvider, ComposerPrimitive, MessagePrimitive, ThreadPrimitive, useExternalStoreRuntime, type AppendMessage, type ThreadMessageLike } from '@assistant-ui/react';
import type { DemoMessage, Snapshot } from '../../contracts/demo.ts';
import { api } from './api.ts';

const convertMessage = (message: DemoMessage): ThreadMessageLike => ({
  id: message.id, role: message.role, createdAt: new Date(message.createdAt), content: [{ type: 'text', text: message.text }],
});
function UserMessage() {
  return <MessagePrimitive.Root className="chat-message user-message"><span className="message-label">你</span><div className="message-text"><MessagePrimitive.Parts /></div></MessagePrimitive.Root>;
}
function AssistantMessage() {
  return <MessagePrimitive.Root className="chat-message assistant-message"><span className="message-label"><span className="small-spark">✳</span> 演示助手</span><div className="message-text"><MessagePrimitive.Parts /></div></MessagePrimitive.Root>;
}

export function AgentPanel({ snapshot, connected }: { snapshot: Snapshot; connected: boolean }) {
  const [error, setError] = useState('');
  const [sending, setSending] = useState(false);
  const [resuming, setResuming] = useState(false);
  const currentTask = snapshot.tasks[0];
  const running = sending || currentTask?.status === 'running';
  const pending = currentTask && currentTask.status !== 'completed';
  const onNew = async (message: AppendMessage) => {
    const text = message.content.filter(part => part.type === 'text').map(part => part.text).join('\n');
    setSending(true); setError('');
    try { await api.send(text); }
    catch (e) { setError((e as Error).message); }
    finally { setSending(false); }
  };
  const runtime = useExternalStoreRuntime({ messages: snapshot.messages, convertMessage, isRunning: running, isDisabled: !connected || Boolean(pending) || sending, onNew });
  const resume = async () => {
    if (!currentTask) return;
    setResuming(true); setError('');
    try { await api.resume(currentTask.id); }
    catch (e) { setError((e as Error).message); }
    finally { setResuming(false); }
  };
  return <aside className="agent-panel" aria-label="演示助手">
    <header className="agent-heading"><div className="agent-icon">✳</div><div><h2>一起构思</h2><span>把想法留在这里</span></div><span className="demo-tag">演示</span></header>
    <div className="agent-note"><span className="status-dot" /> 本阶段使用本机固定回复，无需 API 密钥。</div>
    <AssistantRuntimeProvider runtime={runtime}>
      <ThreadPrimitive.Root className="thread-root">
        <ThreadPrimitive.Viewport className="chat-viewport">
          {snapshot.messages.length === 0 && <div className="chat-welcome"><div className="welcome-symbol">✳</div><h3>每个世界，<br />都始于一个「如果」。</h3><p>给我一个想法。我们先试试消息流，以及任务保存和继续。</p><div className="suggestion">试着写下<br /><strong>“如果灯塔能记住每一个过客……”</strong></div></div>}
          <ThreadPrimitive.Messages components={{ UserMessage, AssistantMessage }} />
        </ThreadPrimitive.Viewport>
        {currentTask && <section className={`task-card ${currentTask.status}`} aria-label="任务进度">
          <div className="task-card-title"><span>{currentTask.status === 'completed' ? '✓' : running ? '◌' : 'Ⅱ'} 演示任务</span><span>{currentTask.status === 'completed' ? '已完成' : running ? '进行中' : '待继续'}</span></div>
          <p>{currentTask.step}</p>
          <progress className="task-progress" aria-label="演示任务进度" max={100} value={currentTask.status === 'completed' ? 100 : currentTask.status === 'running' ? 35 : 66} />
          {currentTask.error && <p className="error-text">{currentTask.error}</p>}
          {!running && currentTask.status !== 'completed' && <><p className="resume-hint">关闭服务后进度仍在，点击后接续同一任务。</p><button className="resume-button" disabled={resuming || !connected} onClick={resume}>{resuming ? '正在继续…' : '继续任务 →'}</button></>}
        </section>}
        {error && <div className="inline-error" role="alert">{error}</div>}
        <ComposerPrimitive.Root className="composer">
          <ComposerPrimitive.Input className="composer-input" placeholder={pending ? '请先完成上方的演示任务' : '写下一个想法…'} aria-label="发送给演示助手" />
          <div className="composer-bottom"><span>{running ? '正在生成演示回复…' : 'Enter 发送 · Shift+Enter 换行'}</span><ComposerPrimitive.Send className="send-button" aria-label="发送消息">↑</ComposerPrimitive.Send></div>
        </ComposerPrimitive.Root>
        <p className="composer-caption">消息和进度保存在本机</p>
      </ThreadPrimitive.Root>
    </AssistantRuntimeProvider>
  </aside>;
}
