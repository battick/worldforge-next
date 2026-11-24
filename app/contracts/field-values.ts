import type { ContentObject, Definition, ObjectKind, WorkspaceState } from './workspace.ts';

export function canonicalValue(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return '[' + value.map(canonicalValue).join(',') + ']';
  return '{' + Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => JSON.stringify(k) + ':' + canonicalValue(v)).join(',') + '}';
}
function jsonValue(value: unknown, depth = 0): boolean {
  if (depth > 20) return false;
  if (value === null || ['string', 'boolean'].includes(typeof value)) return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.every(v => jsonValue(v, depth + 1));
  return Object.getPrototypeOf(value) === Object.prototype && Object.values(value).every(v => jsonValue(v, depth + 1));
}
/** Pure shared checks. The server always repeats these on the complete candidate. */
export function fieldValuesError(state: WorkspaceState, d: Definition, owner: Pick<ContentObject, 'id' | 'worldId'> & { kind: ObjectKind }, values: unknown[]): string | undefined {
  const c = d.constraints;
  if (d.scope !== 'global' && d.scope !== owner.worldId) return '不能使用其他世界的本地字段。';
  if (d.marks.includes('world-status') && (owner.kind !== 'world' || values.length > 1 || values.some(v => !['draft', 'created'].includes(String(v))))) return '创建进度只能用于世界，值为draft或created且至多一项。';
  if (d.marks.includes('navigation-folder') && owner.kind !== 'entry') return '导航文件夹用途只能用于条目。';
  if (values.length < Math.max(c.minCount ?? 0, c.required ? 1 : 0) || values.length > (c.maxCount ?? Infinity)) return '字段值数量不符合约束。';
  const seen = new Set<string>();
  if (c.unique) for (const object of state.objects) if (object.id !== owner.id && (c.unique === 'workspace' || object.worldId === owner.worldId)) for (const value of object.fields[d.id] ?? []) seen.add(canonicalValue(value));
  for (const value of values) {
    if (!jsonValue(value)) return '值必须是有限深度的有效JSON。';
    if (['text', 'choice', 'link'].includes(d.type) && typeof value !== 'string') return '需要文字值。';
    if (d.type === 'link') {
      let url: URL; try { url = new URL(value as string); } catch { return '链接地址格式不正确。'; }
      if (!['http:', 'https:', 'mailto:'].includes(url.protocol)) return '链接协议不受支持。';
    }
    if (d.type === 'number' && (typeof value !== 'number' || !Number.isFinite(value))) return '需要有限数字。';
    if (d.type === 'boolean' && typeof value !== 'boolean') return '需要是或否。';
    if (typeof value === 'string' && (value.length < (c.minLength ?? 0) || value.length > (c.maxLength ?? Infinity) || (c.required && value.length === 0))) return '文字长度不符合约束。';
    if (typeof value === 'number' && (value < (c.min ?? -Infinity) || value > (c.max ?? Infinity))) return '数字超出范围。';
    if (d.type === 'choice' && !c.options?.includes(value as string)) return '值不在允许的选项中。';
    if (d.type === 'reference') {
      const ref = value as { ref?: unknown };
      const destination = ref && typeof ref.ref === 'string' && Object.keys(ref).length === 1 ? state.objects.find(o => o.id === ref.ref) : undefined;
      if (!destination) return '引用对象不存在或格式不正确。';
      if (c.sameWorld && destination.worldId !== owner.worldId) return '此字段限制引用同一世界。';
      if (c.targetKinds && !c.targetKinds.includes(destination.fields['sys.kind']?.[0] as ObjectKind)) return '引用对象用途不符合限制。';
    }
    if (d.type === 'resource') {
      const ref = value as { resource?: unknown; version?: unknown };
      const resource = ref && typeof ref.resource === 'string' && typeof ref.version === 'number' && Object.keys(ref).length === 2 ? state.resources.find(r => r.id === ref.resource) : undefined;
      if (!resource || !state.resourceVersions.some(v => v.id === ref.resource && v.version === ref.version)) return '资源或指定内容版本不存在。';
      if (c.sameWorld && resource.worldId !== owner.worldId) return '此字段限制同一世界的资源。';
    }
    if (c.unique) {
      const key = canonicalValue(value); if (seen.has(key)) return '字段值违反唯一性约束。'; seen.add(key);
    }
  }
}
