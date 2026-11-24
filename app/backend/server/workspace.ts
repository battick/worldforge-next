import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { AppError } from '../core/errors.ts';
import { synchronizeRelations } from '../core/relations.ts';
import { resourceMembership } from './resource-space.ts';
import { canonical, commandSchema, kindOf, objectVersion, roles, systemDefinitions, validateState, type ContentObject, type Definition, type Difference, type HistoryRecord, type Receipt, type ReferenceIndex, type WorkspaceCommand, type WorkspaceState } from '../core/model.ts';

export type CommitStage = 'afterRows' | 'beforeHistory' | 'afterCommit';
export interface PreparedCommand { command: WorkspaceCommand; fingerprint: string; state: WorkspaceState; changes: Difference[]; references: ReferenceIndex[] }
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
function invalid(message: string): never { throw new AppError('MODEL_INVALID', message, 422); }

/** One command boundary for manual writes; future Agent tools must add authorization before calling it. */
export class WorkspaceRepository {
  private prepared = new WeakSet<PreparedCommand>();
  constructor(private db: Database.Database, private notify: () => void = () => {}, private fault?: (stage: CommitStage) => void) {
    db.transaction(() => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS core_meta (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS core_worlds (id TEXT PRIMARY KEY, data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS core_definitions (id TEXT PRIMARY KEY, data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS core_objects (id TEXT PRIMARY KEY, data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS core_resources (id TEXT PRIMARY KEY, data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS core_resource_versions (id TEXT NOT NULL, version INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(id,version));
        CREATE TABLE IF NOT EXISTS core_history (revision INTEGER PRIMARY KEY, operationId TEXT UNIQUE NOT NULL, fingerprint TEXT NOT NULL, data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS core_references (ownerId TEXT NOT NULL, fieldId TEXT NOT NULL, targetId TEXT NOT NULL, kind TEXT NOT NULL, PRIMARY KEY(ownerId,fieldId,targetId,kind));
        CREATE TABLE IF NOT EXISTS core_identities (id TEXT PRIMARY KEY, collection TEXT NOT NULL);
      `);
      if (!db.prepare('SELECT 1 FROM core_meta WHERE id=1').get()) {
        db.prepare('INSERT INTO core_meta VALUES (1,0)').run();
        for (const definition of systemDefinitions()) db.prepare('INSERT INTO core_definitions VALUES (?,?)').run(definition.id, JSON.stringify(definition));
      }
      for (const table of ['definitions', 'objects', 'resources']) db.prepare(`INSERT OR IGNORE INTO core_identities SELECT id, '${table}' FROM core_${table}`).run();
      db.pragma('user_version = 2');
    })();
  }

  read(): WorkspaceState {
    return this.db.transaction(() => {
      const rows = <T>(table: string) => (this.db.prepare(`SELECT data FROM ${table} ORDER BY id`).all() as { data: string }[]).map(row => JSON.parse(row.data) as T);
      return resourceMembership({
        revision: (this.db.prepare('SELECT revision FROM core_meta WHERE id=1').get() as { revision: number }).revision,
        worlds: rows<WorkspaceState['worlds'][number]>('core_worlds'), definitions: rows<Definition>('core_definitions'), objects: rows<ContentObject>('core_objects'),
        resources: rows<WorkspaceState['resources'][number]>('core_resources'), resourceVersions: rows<WorkspaceState['resourceVersions'][number]>('core_resource_versions'),
      }, this.history());
    })();
  }

  history(): HistoryRecord[] { return (this.db.prepare('SELECT data FROM core_history ORDER BY revision DESC').all() as { data: string }[]).map(row => JSON.parse(row.data)); }
  references(): ReferenceIndex[] { return this.db.prepare('SELECT * FROM core_references ORDER BY ownerId,fieldId,targetId').all() as ReferenceIndex[]; }
  private prior(command: WorkspaceCommand, fingerprint: string): Receipt | undefined {
    const row = this.db.prepare('SELECT revision, fingerprint FROM core_history WHERE operationId=?').get(command.operationId) as { revision: number; fingerprint: string } | undefined;
    if (!row) return;
    if (row.fingerprint !== fingerprint) throw new AppError('OPERATION_CONFLICT', '同一操作编号已经用于不同的修改。', 409);
    return { operationId: command.operationId, revision: row.revision };
  }

  prepare(input: unknown): PreparedCommand | Receipt {
    const command = commandSchema.parse(input);
    const fingerprint = hash(canonical(command));
    const prior = this.prior(command, fingerprint);
    if (prior) return prior;
    const before = this.read();
    if (before.revision !== command.baseRevision) throw new AppError('VERSION_CONFLICT', '资料已改变，请读取当前版本后重新准备修改。', 409);
    const state = structuredClone(before);
    const now = new Date().toISOString();
    const touch = new Set<string>();
    const used = new Set<string>();
    const upsert = <T extends { id: string }>(list: T[], item: T) => { const index = list.findIndex(o => o.id === item.id); if (index < 0) list.push(item); else list[index] = item; };
    const remove = <T extends { id: string }>(list: T[], id: string) => { const index = list.findIndex(o => o.id === id); if (index < 0) invalid('要删除的内容不存在。'); list.splice(index, 1); };
    const checkBusinessFields = (fields: Record<string, unknown[]>) => {
      if (Object.keys(fields).some(fid => fid.startsWith('sys.'))) invalid('身份、用途和时间版本字段由系统维护。');
    };
    for (const change of command.changes) {
      const itemId = change.type === 'definition.put' ? change.definition.id : change.id;
      const family = change.type.split('.')[0];
      const key = `${family}:${itemId}`;
      if (used.has(key)) invalid('同一命令对同一对象只允许一份完整修改。');
      used.add(key);
      switch (change.type) {
        case 'world.create': {
          if (state.worlds.some(w => w.id === change.id) || state.objects.some(o => o.id === change.id)) invalid('世界身份已存在。');
          state.worlds.push({ id: change.id, rootId: change.id });
          state.objects.push({ id: change.id, worldId: change.id, fields: { 'sys.kind': ['world'] } });
          touch.add(change.id); break;
        }
        case 'definition.put': {
          const previous = state.definitions.find(d => d.id === change.definition.id);
          const scope = change.definition.scope ?? previous?.scope ?? command.worldId;
          if (!scope) invalid('新增字段需要当前世界，或明确选择全局归属。');
          if (change.definition.id.startsWith('sys.') || change.definition.system) {
            if (!previous?.system) invalid('不能创建额外的系统字段。');
            const { name: _n, comment: _c, ...next } = { ...change.definition, scope };
            const { version: _v, name: _pn, comment: _pc, ...old } = previous;
            if (canonical(next) !== canonical(old)) invalid('不能修改系统字段的职责、类型或约束。');
          }
          if (previous && previous.scope !== scope) invalid('不能直接改变已有定义的归属，请显式建立和迁移字段。');
          upsert(state.definitions, { ...change.definition, scope, version: (previous?.version ?? 0) + 1 }); break;
        }
        case 'definition.delete':
          if (change.id.startsWith('sys.')) invalid('系统字段不能删除。');
          remove(state.definitions, change.id); break;
        case 'object.create':
          if (change.kind === 'world') invalid('世界根对象通过世界创建命令生成。');
          if (state.objects.some(o => o.id === change.id)) invalid('对象身份已经存在。');
          checkBusinessFields(change.fields);
          state.objects.push({ id: change.id, worldId: change.worldId, fields: { ...change.fields, 'sys.kind': [change.kind] } }); touch.add(change.id); break;
        case 'object.update': {
          const object = state.objects.find(o => o.id === change.id);
          if (!object) invalid('要修改的对象不存在。');
          checkBusinessFields(change.set ?? {});
          if (change.unset?.some(fid => fid.startsWith('sys.'))) invalid('系统字段不能移除。');
          Object.assign(object.fields, change.set);
          for (const fid of change.unset ?? []) delete object.fields[fid];
          touch.add(object.id); break;
        }
        case 'object.delete': {
          const object = state.objects.find(o => o.id === change.id);
          if (!object || kindOf(object) === 'world') invalid('不能以条目删除操作删除世界根对象。');
          remove(state.objects, change.id); break;
        }
        case 'resource.put': {
          const previous = state.resources.find(r => r.id === change.id);
          if (previous && previous.worldId !== change.worldId) invalid('资源不能直接改属其他世界。');
          if (!change.path || change.path.includes('\\') || change.path.includes('\0') || change.path.split('/').some(part => !part || part === '.' || part === '..' || part.includes(':'))) invalid('资源需要世界内的相对逻辑路径。');
          const bytes = Buffer.from(change.content, 'base64');
          if (bytes.toString('base64') !== change.content || bytes.length > 1_000_000) invalid('资源内容不是有效Base64，或超过本阶段1MB上限。');
          if (!previous && state.resourceVersions.some(v => v.id === change.id)) invalid('历史资源身份不可重新使用。');
          const version = (previous?.version ?? 0) + 1;
          upsert(state.resources, { id: change.id, worldId: change.worldId, path: change.path, version, space: change.space ?? previous?.space ?? true });
          state.resourceVersions.push({ id: change.id, version, mime: change.mime, content: change.content, hash: createHash('sha256').update(bytes).digest('hex') }); break;
        }
        case 'resource.delete': remove(state.resources, change.id); break;
      }
    }
    for (const id of synchronizeRelations(state)) touch.add(id);
    for (const id of touch) {
      const object = state.objects.find(o => o.id === id)!;
      const old = before.objects.find(o => o.id === id);
      object.fields['sys.id'] = [id]; object.fields['sys.created'] = old?.fields['sys.created'] ?? [now];
      object.fields['sys.updated'] = [now]; object.fields['sys.version'] = [(old ? objectVersion(old) : 0) + 1];
    }
    const references = validateState(state);
    const changes: Difference[] = [];
    for (const collection of ['worlds', 'definitions', 'objects', 'resources'] as const) {
      const previous = new Map<string, unknown>(before[collection].map(row => [row.id, row]));
      const next = new Map<string, unknown>(state[collection].map(row => [row.id, row]));
      for (const id of new Set([...previous.keys(), ...next.keys()])) {
        const a = previous.get(id) ?? null, b = next.get(id) ?? null;
        if (canonical(a) !== canonical(b)) changes.push({ collection, id, before: a, after: b });
      }
    }
    for (const change of changes) if (change.before === null && change.collection !== 'worlds' && this.db.prepare('SELECT 1 FROM core_identities WHERE id=?').get(change.id)) invalid('历史身份不可重新使用。');
    const result = { command, fingerprint, state, changes, references };
    const freeze = (value: unknown) => {
      if (value && typeof value === 'object' && !Object.isFrozen(value)) { Object.values(value).forEach(freeze); Object.freeze(value); }
    };
    freeze(result); this.prepared.add(result);
    return result;
  }

  execute(input: unknown): Receipt { return this.commit(this.prepare(input)); }
  commit(prepared: PreparedCommand | Receipt): Receipt {
    if (!('command' in prepared)) return prepared;
    if (!this.prepared.has(prepared)) invalid('准备结果不属于当前修改入口，请重新准备。');
    const { command, fingerprint, state, changes, references } = prepared;
    const result = this.db.transaction(() => {
      const prior = this.prior(command, fingerprint);
      if (prior) return prior;
      const current = (this.db.prepare('SELECT revision FROM core_meta WHERE id=1').get() as { revision: number }).revision;
      if (current !== command.baseRevision) throw new AppError('VERSION_CONFLICT', '准备期间资料已更新，修改没有应用。', 409);
      const table = { worlds: 'core_worlds', definitions: 'core_definitions', objects: 'core_objects', resources: 'core_resources' };
      for (const change of changes) {
        if (change.before === null && change.collection !== 'worlds') this.db.prepare('INSERT INTO core_identities VALUES (?,?)').run(change.id, change.collection);
        if (change.after === null) this.db.prepare(`DELETE FROM ${table[change.collection]} WHERE id=?`).run(change.id);
        else this.db.prepare(`INSERT INTO ${table[change.collection]} VALUES (?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data`).run(change.id, JSON.stringify(change.after));
      }
      for (const version of state.resourceVersions) this.db.prepare('INSERT OR IGNORE INTO core_resource_versions VALUES (?,?,?)').run(version.id, version.version, JSON.stringify(version));
      this.fault?.('afterRows');
      this.db.prepare('DELETE FROM core_references').run();
      for (const ref of references) this.db.prepare('INSERT OR IGNORE INTO core_references VALUES (?,?,?,?)').run(ref.ownerId, ref.fieldId, ref.targetId, ref.kind);
      this.fault?.('beforeHistory');
      const revision = current + 1;
      const record: HistoryRecord = { operationId: command.operationId, revision, baseRevision: current, actor: 'user', createdAt: new Date().toISOString(), changes };
      this.db.prepare('INSERT INTO core_history VALUES (?,?,?,?)').run(revision, command.operationId, fingerprint, JSON.stringify(record));
      this.db.prepare('UPDATE core_meta SET revision=? WHERE id=1').run(revision);
      return { operationId: command.operationId, revision };
    }).immediate();
    this.fault?.('afterCommit');
    this.notify();
    return result;
  }
}
