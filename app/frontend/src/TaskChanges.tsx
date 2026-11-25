import type { Change, Constraints, DefinitionInput, WorkspaceCommand, WorkspaceState } from '../../contracts/workspace.ts';
import { titleOf } from '../../client/wiki.ts';

const typeNames = { text: '文字', number: '数字', boolean: '是或否', choice: '选项', link: '链接', reference: '对象引用', resource: '文件或正文资源', json: '结构化内容' };
const markNames: Record<string, string> = { identity: '稳定身份', kind: '对象用途', created: '创建时间', updated: '修改时间', version: '版本', title: '标题', body: '正文', classification: '分类', navigation: '导航位置', source: '关系起点', target: '关系目标', 'time-start': '开始时间', 'time-end': '结束时间', 'time-point': '时间点', summary: '摘要', cover: '封面', 'world-status': '世界创建状态', 'navigation-folder': '导航文件夹', 'relation-definition': '关系定义', 'relation-fields': '关系字段配置', 'relation-type': '采用的关系定义' };
const constraintNames: Record<keyof Constraints, string> = { required: '必须有值', minCount: '最少值数量', maxCount: '最多值数量', min: '最小数值', max: '最大数值', minLength: '最短文字长度', maxLength: '最长文字长度', options: '可选内容', unique: '值不能重复的范围', targetKinds: '允许引用的对象', sameWorld: '只能引用同一世界' };
const kindNames: Record<string, string> = { world: '世界', entry: '条目', relation: '关系' };
function rules(constraints: Constraints) {
  return Object.entries(constraints).map(([key, value]) => {
    const readable = typeof value === 'boolean' ? value ? '是' : '否' : key === 'unique' ? value === 'world' ? '当前世界' : '全部世界' : Array.isArray(value) ? value.map(v => key === 'targetKinds' ? kindNames[v] ?? v : v).join('、') : String(value);
    return `${constraintNames[key as keyof Constraints] ?? key}：${readable}`;
  }).join('\n') || '无附加限制';
}

export function TaskChanges({ command, workspace }: { command: WorkspaceCommand; workspace?: WorkspaceState }) {
  if (!workspace) return <p>正在读取字段规则与影响范围，读取后可授权。</p>;
  const objectName = (id: string) => {
    const object = workspace.objects.find(o => o.id === id);
    return object ? titleOf(workspace, object) : `新建或已移除的内容 · ${id.slice(0, 8)}`;
  };
  const fieldName = (id: string) => {
    const change = command.changes.find(c => c.type === 'definition.put' && c.definition.id === id);
    return change?.type === 'definition.put' ? change.definition.name : workspace.definitions.find(d => d.id === id)?.name ?? '字段';
  };
  const scopeName = (scope: string | undefined) => scope === 'global' ? '全局（各世界共用定义）' : scope ? `世界：${objectName(scope)}` : '尚未指定归属';
  const definitionPreview = (definition: Extract<Change, { type: 'definition.put' }>['definition'], index: number) => {
    const old = workspace.definitions.find(d => d.id === definition.id), next = { ...definition, scope: definition.scope ?? old?.scope ?? command.worldId };
    const row = (label: string, display: (d: DefinitionInput) => string) => <tr key={label}><th scope="row">{label}</th><td>{old ? display(old) : '尚不存在'}</td><td>{display(next as DefinitionInput)}</td></tr>;
    const affected = workspace.objects.filter(o => definition.id in o.fields), worlds = new Set(affected.map(o => o.worldId));
    return <section className="collaboration-definition" aria-label={`字段规则变更：${definition.name}`} key={index}>
      <h5>{old ? '修改' : '新增'}字段“{definition.name}”</h5>
      <div className="collaboration-rule-table"><table><thead><tr><th>项目</th><th>当前已保存</th><th>本任务拟保存</th></tr></thead><tbody>
        {row('名称', d => d.name)}{row('取值类型', d => typeNames[d.type])}{row('归属', d => scopeName(d.scope))}
        {row('功能用途', d => d.marks.map(m => markNames[m] ?? m).join('、') || '无')}{row('取值规则', d => rules(d.constraints))}{row('说明', d => d.comment || '无')}
      </tbody></table></div>
      <p>当前采用此字段：{affected.length}项内容，涉及{worlds.size}个世界。定义和受影响的值会一起检查。</p>
      <ul className="collaboration-affected">{affected.map(o => <li key={o.id}>{objectName(o.worldId)} / {objectName(o.id)} · {o.id.slice(0, 8)}</li>)}</ul>
    </section>;
  };
  const describe = (change: Exclude<Change, { type: 'definition.put' }>) => {
    if (change.type === 'definition.delete') return `删除字段定义 · ${fieldName(change.id)}`;
    if (change.type === 'resource.put') {
      let preview = ''; try { if (change.mime.startsWith('text/')) preview = new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(atob(change.content), c => c.charCodeAt(0))); } catch {}
      return `保存文件 · ${change.path}${preview ? `\n${preview.slice(0, 1000)}${preview.length > 1000 ? '…（仅显示前1000字）' : ''}` : ''}`;
    }
    if (change.type === 'resource.delete') return `删除文件 · ${workspace.resources.find(r => r.id === change.id)?.path ?? change.id}`;
    if (change.type === 'object.delete') return `删除条目内容 · ${objectName(change.id)}`;
    if (change.type === 'world.create') return '创建新世界';
    const values = change.type === 'object.create' ? change.fields : change.set ?? {};
    return `${change.type === 'object.create' ? '创建内容' : `修改 · ${objectName(change.id)}`}\n${Object.entries(values).map(([id, values]) => `${fieldName(id)}：${values.map(v => typeof v === 'string' ? v : JSON.stringify(v)).join('、') || '空值'}`).join('\n')}${change.type === 'object.update' && change.unset?.length ? `\n移除字段：${change.unset.map(fieldName).join('、')}` : ''}`;
  };
  return <>{command.changes.map((change, i) => change.type === 'definition.put' ? definitionPreview(change.definition, i) : <pre className="collaboration-preview" key={i}>{describe(change)}</pre>)}</>;
}
