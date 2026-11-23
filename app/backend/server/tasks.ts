import { Annotation, Command, END, START, StateGraph, interrupt } from '@langchain/langgraph';
import { SqliteSaver } from '@langchain/langgraph-checkpoint-sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { AppError } from '../core/errors.ts';
import { Store } from './store.ts';

const State = Annotation.Root({ id: Annotation<string>(), prompt: Annotation<string>(), prepared: Annotation<boolean>(), finished: Annotation<boolean>() });

export class DemoTasks {
  private active = new Map<string, Promise<void>>();
  private controller = new AbortController();
  private graph;

  constructor(private store: Store, private tickMs = 30) {
    const checkpointer = new SqliteSaver(store.db);
    this.graph = new StateGraph(State)
      .addNode('prepare', async (state) => {
        this.store.setTask(state.id, 'running', '1 / 3 · 保存输入并生成演示回复');
        await this.streamReply(state.id, this.preview(state.prompt));
        return { prepared: true };
      })
      .addNode('wait_for_user', () => {
        interrupt({ reason: '演示进度已保存。点击继续后接着执行。' });
        return {};
      })
      .addNode('finish', async (state) => {
        this.store.setTask(state.id, 'running', '3 / 3 · 接续原任务并完成');
        await this.streamReply(state.id, this.preview(state.prompt) + '\n\n任务已从保存的位置继续并完成。你的输入和这段回复已保存在本机；刷新后仍可查看。');
        return { finished: true };
      })
      .addEdge(START, 'prepare').addEdge('prepare', 'wait_for_user')
      .addEdge('wait_for_user', 'finish').addEdge('finish', END)
      .compile({ checkpointer });
  }

  private preview(prompt: string) {
    return `已收到「${prompt}」。\n\n这是本机演示回复，没有调用真实模型，也没有修改世界资料。第一步已完成，执行进度已保存。\n\n可以现在关闭并重新启动服务，再点击任务卡片上的“继续”，检验任务接续。`;
  }

  private async streamReply(id: string, target: string) {
    const previous = this.store.reply(id);
    // A graph node can replay after a crash. Persisted prefixes are not appended twice.
    if (!target.startsWith(previous)) {
      if (previous.startsWith(target)) return;
      throw new Error('演示回复与检查点不一致。');
    }
    for (let length = previous.length; length < target.length;) {
      this.controller.signal.throwIfAborted();
      length = Math.min(target.length, length + 6);
      this.store.saveReply(id, target.slice(0, length));
      await delay(this.tickMs, undefined, { signal: this.controller.signal });
    }
  }

  start(prompt: string) {
    const id = randomUUID();
    this.store.createTask(id, prompt);
    this.launch(id, false);
    return id;
  }

  resume(id: string) {
    const task = this.store.task(id);
    if (task.status === 'completed') return; // A duplicate click must not replay a completed task.
    if (this.active.has(id)) throw new AppError('TASK_RUNNING', '任务正在执行。', 409);
    this.store.setTask(id, 'running', '正在读取已保存进度');
    this.launch(id, true);
  }

  private launch(id: string, resume: boolean) {
    const run = this.run(id, resume).finally(() => { this.active.delete(id); });
    this.active.set(id, run);
  }

  private async run(id: string, resume: boolean) {
    try {
      const config = { configurable: { thread_id: `demo-task:${id}` } };
      const task = this.store.task(id);
      const saved = await this.graph.getState(config);
      let input: Parameters<typeof this.graph.invoke>[0];
      if (!saved.createdAt) input = { id, prompt: task.prompt, prepared: false, finished: false };
      else if (saved.tasks.some(t => t.interrupts?.length)) input = new Command({ resume: true });
      else if (!saved.next.length) {
        this.store.setTask(id, 'completed', '3 / 3 · 演示任务已完成');
        return;
      } else input = null;
      // Only an explicit resume call is allowed to pass a saved interrupt.
      if (!resume && saved.createdAt) throw new Error('新的任务不应带有旧检查点。');
      await this.graph.invoke(input, config);
      const result = await this.graph.getState(config);
      this.store.setTask(id, result.next.length ? 'waiting' : 'completed', result.next.length ? '2 / 3 · 已保存进度，等待继续' : '3 / 3 · 演示任务已完成');
    } catch (error) {
      if (this.controller.signal.aborted) this.store.setTask(id, 'interrupted', '服务已关闭，请点击继续');
      else this.store.setTask(id, 'failed', '执行失败，可重试继续', error instanceof Error ? error.message : '执行失败');
    }
  }

  async stop() {
    this.controller.abort();
    await Promise.allSettled(this.active.values());
  }
}
