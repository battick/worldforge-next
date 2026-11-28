import Database from 'better-sqlite3';
import { EventEmitter } from 'node:events';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { AppError } from '../core/errors.ts';
import { acquireDataLock } from './data-lock.ts';
import type { DemoDocument, DemoMessage, DemoTask, Snapshot, TaskStatus } from '../../contracts/demo.ts';

export const SAMPLE_MARKDOWN = `# 雾海来信

这里是你的第一张创作纸。写下一个念头，让世界从这里生长。

## 一个尚未命名的世界

群岛漂浮在永不散去的雾海上。人们依靠**灯塔**辨认航路，却没有人知道雾从何处而来。

- 港口：白鹭港
- 线索：一封没有寄件人的信
- 待定：灯塔熄灭之后会发生什么？

> 这是组件接入阶段的虚构示例，可以自由修改并保存。

稳定双链示例：[[entry-lighthouse|旧灯塔]]。此阶段保留文字，不会自动创建条目。

| 地点 | 状态 |
| --- | --- |
| 旧灯塔 | 待探索 |

\`\`\`text
在这里保留笔记、列表与代码片段。
\`\`\`
`;

/** Demo tables are intentionally separate from the future unified field model. */
export class Store {
  readonly db: Database.Database;
  readonly events = new EventEmitter();
  private releaseLock: () => void;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.releaseLock = acquireDataLock(dataDir);
    let opened: Database.Database | undefined;
    try {
      this.db = opened = new Database(path.join(dataDir, 'worldforge.sqlite'));
      this.db.pragma('journal_mode = WAL');
      this.db.pragma('foreign_keys = ON');
      this.db.pragma('busy_timeout = 5000');
      this.db.pragma('synchronous = FULL');
      this.migrate();
    } catch (error) {
      opened?.close();
      this.releaseLock();
      throw error;
    }
  }

  private migrate() {
    const version = this.db.pragma('user_version', { simple: true }) as number;
    if (version > 2) throw new Error('数据版本较新，请使用对应版本的程序。');
    if (version === 0) this.db.transaction(() => {
      this.db.exec(`
        CREATE TABLE demo_document (id INTEGER PRIMARY KEY CHECK (id = 1), markdown TEXT NOT NULL, version INTEGER NOT NULL, updatedAt TEXT NOT NULL);
        CREATE TABLE demo_tasks (id TEXT PRIMARY KEY, prompt TEXT NOT NULL, status TEXT NOT NULL, step TEXT NOT NULL, error TEXT, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL);
        CREATE TABLE demo_messages (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, role TEXT NOT NULL, text TEXT NOT NULL, createdAt TEXT NOT NULL);
        CREATE TABLE app_events (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, createdAt TEXT NOT NULL);
        PRAGMA user_version = 1;
      `);
      this.db.prepare('INSERT INTO demo_document VALUES (1, ?, 1, ?)').run(SAMPLE_MARKDOWN, new Date().toISOString());
    })();
    // Merely opening the application never invokes the graph.
    this.db.prepare("UPDATE demo_tasks SET status='interrupted', step='程序已中断，请点击继续', updatedAt=? WHERE status='running'").run(new Date().toISOString());
  }

  snapshot(): Snapshot {
    return this.db.transaction(() => ({
      eventId: (this.db.prepare('SELECT coalesce(max(id), 0) AS id FROM app_events').get() as { id: number }).id,
      document: this.db.prepare('SELECT markdown, version, updatedAt FROM demo_document').get() as DemoDocument,
      messages: this.db.prepare('SELECT id, role, text, createdAt FROM demo_messages ORDER BY seq').all() as DemoMessage[],
      tasks: this.db.prepare('SELECT * FROM demo_tasks ORDER BY createdAt DESC, id').all() as DemoTask[],
    }))();
  }

  private change(kind: string, action: () => void) {
    this.db.transaction(() => {
      action();
      this.db.prepare('INSERT INTO app_events(kind, createdAt) VALUES (?, ?)').run(kind, new Date().toISOString());
    })();
    this.events.emit('change');
  }

  saveDocument(markdown: string, version: number) {
    this.change('document.saved', () => {
      const result = this.db.prepare('UPDATE demo_document SET markdown=?, version=version+1, updatedAt=? WHERE id=1 AND version=?').run(markdown, new Date().toISOString(), version);
      if (!result.changes) throw new AppError('VERSION_CONFLICT', '正文已在其他页面更新。请先保留本地文字，再载入已保存版本。', 409);
    });
    return this.snapshot().document;
  }

  createTask(id: string, prompt: string) {
    this.change('task.created', () => {
      if (this.db.prepare("SELECT 1 FROM demo_tasks WHERE status != 'completed'").get()) {
        throw new AppError('TASK_PENDING', '请先继续并完成当前演示任务。', 409);
      }
      const now = new Date().toISOString();
      this.db.prepare('INSERT INTO demo_tasks VALUES (?, ?, ?, ?, NULL, ?, ?)').run(id, prompt, 'running', '正在保存输入', now, now);
      this.db.prepare('INSERT INTO demo_messages(id, role, text, createdAt) VALUES (?, ?, ?, ?)').run(`${id}:user`, 'user', prompt, now);
      this.db.prepare('INSERT INTO demo_messages(id, role, text, createdAt) VALUES (?, ?, ?, ?)').run(`${id}:assistant`, 'assistant', '', now);
    });
  }

  task(id: string) {
    const task = this.db.prepare('SELECT * FROM demo_tasks WHERE id=?').get(id) as DemoTask | undefined;
    if (!task) throw new AppError('NOT_FOUND', '未找到这个任务。', 404);
    return task;
  }

  setTask(id: string, status: TaskStatus, step: string, error: string | null = null) {
    this.change('task.updated', () => this.db.prepare('UPDATE demo_tasks SET status=?, step=?, error=?, updatedAt=? WHERE id=?').run(status, step, error, new Date().toISOString(), id));
  }

  reply(id: string): string {
    return (this.db.prepare('SELECT text FROM demo_messages WHERE id=?').get(`${id}:assistant`) as { text: string }).text;
  }

  saveReply(id: string, text: string) {
    this.change('message.delta', () => this.db.prepare('UPDATE demo_messages SET text=? WHERE id=?').run(text, `${id}:assistant`));
  }

  close() { try { this.db.close(); } finally { this.releaseLock(); } }
}
