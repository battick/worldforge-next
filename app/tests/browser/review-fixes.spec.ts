import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { bodyRefs, command, encodeText, newObject, newWorld, saveBody } from '../../client/wiki.ts';
import type { WorkspaceCommand, WorkspaceView } from '../../contracts/workspace.ts';

const snapshot = async (request: APIRequestContext): Promise<WorkspaceView> => (await request.get('/api/core/snapshot')).json();
async function execute(request: APIRequestContext, data: WorkspaceCommand) { const r = await request.post('/api/core/commands', { data }); expect(r.ok(), await r.text()).toBe(true); }
async function createWorld(page: Page, name: string) {
  await page.goto('/#wiki'); await page.getByRole('button', { name: '创建世界', exact: true }).click();
  await page.getByRole('textbox', { name: '新世界名称', exact: true }).fill(name);
  await page.getByRole('button', { name: '保存世界草案', exact: true }).click();
  await expect(page).toHaveURL(/#wiki\/[a-f0-9-]+\/[a-f0-9-]+$/); return page.url().split('/').at(-1)!;
}

for (const fieldsFirst of [false, true]) test(`unified entry save preserves body and fields in one command, fields first=${fieldsFirst}`, async ({ page, request }) => {
  const wid = await createWorld(page, fieldsFirst ? '先字段' : '先正文');
  const active = page.locator('.wiki-entry:not([hidden])');
  await expect(active.getByRole('textbox', { name: '名称 第1项', exact: true })).toHaveCount(0);
  const before = await snapshot(request), commands: WorkspaceCommand[] = [];
  await page.route('**/api/core/commands', async route => { commands.push(route.request().postDataJSON()); await route.continue(); });
  if (fieldsFirst) { await active.getByRole('button', { name: '编辑条目', exact: true }).click(); await active.getByRole('textbox', { name: '名称 第1项', exact: true }).fill('联合新名'); }
  await active.getByRole('button', { name: '正文源码', exact: true }).click();
  await active.getByRole('textbox', { name: '条目Markdown源码', exact: true }).fill('# 联合正文');
  if (!fieldsFirst) await active.getByRole('textbox', { name: '名称 第1项', exact: true }).fill('联合新名');
  await active.getByRole('button', { name: '保存条目', exact: true }).click();
  await expect(active.getByRole('status')).toContainText('条目已保存');
  await expect(active.getByRole('textbox', { name: '名称 第1项', exact: true })).toHaveCount(0);
  await expect(active.locator('.wiki-markdown')).toContainText('联合正文');
  const after = await snapshot(request), object = after.state.objects.find(o => o.id === wid)!;
  expect(after.state.revision).toBe(before.state.revision + 1); expect(commands).toHaveLength(1);
  expect(commands[0]!.changes.filter(c => c.type === 'object.update')).toHaveLength(1);
  expect(Object.values(object.fields)).toContainEqual(['联合新名']);
  const body = bodyRefs(after.state, object)[0]!; expect(after.state.resourceVersions.find(v => v.id === body.resource && v.version === body.version)!.content).toBe(encodeText('# 联合正文'));
  await page.getByRole('button', { name: '空间', exact: true }).click(); await expect(page.locator('.wiki-file-list')).toContainText('空间还没有文件');
});

test('ordinary links replace a tab; Ctrl and middle clicks open tabs and cancelled navigation preserves drafts', async ({ page, request }) => {
  let state = (await snapshot(request)).state; const world = newWorld(state, '页签修复', ''); await execute(request, world.command);
  const ids: string[] = [];
  for (const name of ['甲页', '乙页', '丙页']) { state = (await snapshot(request)).state; const object = newObject(state, world.worldId, name, 'entry'); await execute(request, object.command); ids.push(object.id); }
  state = (await snapshot(request)).state; const a = state.objects.find(o => o.id === ids[0])!, body = bodyRefs(state, a)[0]!;
  await execute(request, saveBody(state, a, `[[${ids[1]}|乙页链接]]\n\n[[${ids[2]}|丙页链接]]\n\n[[${world.worldId}|世界链接]]`, body.fieldId, body.resource));
  await page.goto(`/#wiki/${world.worldId}/${ids[0]}`);
  const active = page.locator('.wiki-entry:not([hidden])'), tabs = page.getByRole('tablist', { name: '已打开条目', exact: true });
  await expect(tabs.getByRole('tab')).toHaveCount(1); await active.getByRole('button', { name: '乙页链接', exact: true }).click();
  await expect(active.getByRole('heading', { name: '乙页', exact: true })).toBeVisible(); await expect(tabs.getByRole('tab')).toHaveCount(1);
  await page.locator('.wiki-results').getByRole('button', { name: /^甲页/ }).click({ modifiers: ['Control'] });
  await expect(tabs.getByRole('tab')).toHaveCount(2);
  await active.getByRole('button', { name: '正文源码', exact: true }).click();
  const source = active.getByRole('textbox', { name: '条目Markdown源码', exact: true }); const draft = (await source.inputValue()) + '\n\n保留的草稿'; await source.fill(draft);
  await active.getByRole('button', { name: '阅读正文', exact: true }).click();
  page.once('dialog', dialog => dialog.dismiss()); await active.getByRole('button', { name: '丙页链接', exact: true }).click();
  await expect(active.getByRole('heading', { name: '甲页', exact: true })).toBeVisible(); await expect(tabs.getByRole('tab')).toHaveCount(2);
  await active.getByRole('button', { name: '丙页链接', exact: true }).click({ modifiers: ['Control'] }); await expect(tabs.getByRole('tab')).toHaveCount(3);
  await tabs.getByRole('tab', { name: '甲页', exact: true }).click();
  await active.getByRole('button', { name: '正文源码', exact: true }).click(); await expect(source).toHaveValue(draft);
  await active.getByRole('button', { name: '阅读正文', exact: true }).click(); await active.getByRole('button', { name: '世界链接', exact: true }).click({ button: 'middle' });
  await expect(tabs.getByRole('tab')).toHaveCount(4); await tabs.getByRole('tab', { name: '甲页', exact: true }).click();
  await active.getByRole('button', { name: '正文源码', exact: true }).click(); await expect(source).toHaveValue(draft);
});

test('relation definition UI creates configured instances and updates new fields without replacing existing values', async ({ page, request }) => {
  const wid = await createWorld(page, '关系配置修复');
  const year = crypto.randomUUID(), intro = crypto.randomUUID(); let state = (await snapshot(request)).state;
  await execute(request, command(state, wid, [
    { type: 'definition.put', definition: { id: year, scope: wid, name: '加入年', type: 'number', marks: [], constraints: { min: 0 } } },
    { type: 'definition.put', definition: { id: intro, scope: wid, name: '关系说明', type: 'text', marks: [], constraints: {} } },
  ]));
  await page.getByRole('button', { name: '重新读取世界', exact: true }).click();
  await page.getByRole('button', { name: '关系定义', exact: true }).click();
  const panel = page.getByRole('region', { name: '关系定义管理', exact: true });
  await panel.getByRole('textbox', { name: '关系定义名称', exact: true }).fill('师徒'); await panel.getByRole('checkbox', { name: '采用加入年', exact: true }).check();
  await panel.getByText('新附加字段的初始值（可选）', { exact: true }).click(); await panel.getByRole('textbox', { name: '关系字段初始值', exact: true }).fill(JSON.stringify({ [year]: [3] }));
  await panel.getByRole('button', { name: '保存关系定义', exact: true }).click(); await expect(panel.getByRole('status')).toContainText('关系定义已保存');
  await page.getByRole('button', { name: 'Wiki', exact: true }).click(); await page.getByRole('button', { name: '新建关系', exact: true }).click();
  await page.getByRole('combobox', { name: '选择关系定义', exact: true }).selectOption({ label: '师徒' });
  await page.getByRole('textbox', { name: '新内容名称', exact: true }).fill('师徒实例');
  await page.getByRole('spinbutton', { name: '加入年 第1项', exact: true }).fill('7');
  await page.getByRole('listbox', { name: '关系起点（可多选）', exact: true }).selectOption(wid); await page.getByRole('listbox', { name: '关系目标（可多选）', exact: true }).selectOption(wid);
  await page.getByRole('button', { name: '保存新内容', exact: true }).click(); await expect(page.locator('.wiki-entry:not([hidden])').getByRole('heading', { name: '师徒实例', exact: true })).toBeVisible();
  const instance = page.url().split('/').at(-1)!;
  await page.getByRole('button', { name: '关系定义', exact: true }).click(); await panel.getByRole('checkbox', { name: '采用关系说明', exact: true }).check();
  await panel.getByRole('textbox', { name: '关系字段初始值', exact: true }).fill(JSON.stringify({ [year]: [3], [intro]: ['共同的初始说明'] }));
  await panel.getByRole('button', { name: '保存关系定义', exact: true }).click(); await expect(panel.getByRole('status')).toContainText('关系定义已保存');
  state = (await snapshot(request)).state; expect(state.objects.find(o => o.id === instance)!.fields[year]).toEqual([7]); expect(state.objects.find(o => o.id === instance)!.fields[intro]).toEqual(['共同的初始说明']);
  await page.getByRole('button', { name: 'Wiki', exact: true }).click(); const active = page.locator('.wiki-entry:not([hidden])'); await expect(active.getByRole('region', { name: '条目字段', exact: true })).toContainText('共同的初始说明');
});
