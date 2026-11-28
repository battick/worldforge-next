import { test, expect, type Page, type APIRequestContext } from '@playwright/test';
import { newWorld, newObject, relationDefinitionCommand, titleOf } from '../../client/wiki.ts';
import type { WorkspaceCommand, WorkspaceView } from '../../contracts/workspace.ts';

const snapshot = async (request: APIRequestContext): Promise<WorkspaceView> => (await request.get('/api/core/snapshot')).json();
async function execute(request: APIRequestContext, data: WorkspaceCommand) { const response = await request.post('/api/core/commands', { data }); expect(response.ok(), await response.text()).toBe(true); }
async function fixture(request: APIRequestContext) {
  const world = newWorld((await snapshot(request)).state, `回归世界${crypto.randomUUID().slice(0, 8)}`, ''); await execute(request, world.command);
  const ids: string[] = [];
  for (const name of ['甲页', '乙页']) { const object = newObject((await snapshot(request)).state, world.worldId, name, 'entry'); await execute(request, object.command); ids.push(object.id); }
  return { wid: world.worldId, a: ids[0]!, b: ids[1]! };
}
async function holdCommand(page: Page) {
  let release!: () => void, arrived!: () => void;
  const gate = new Promise<void>(r => { release = r; }), seen = new Promise<void>(r => { arrived = r; });
  await page.route('**/api/core/commands', async route => { arrived(); await gate; await route.continue(); });
  return { release, seen };
}

test('a locally saved document never rolls back to an older SSE prop', async ({ page, request }) => {
  await page.route('**/api/events', route => route.abort()); await page.goto('/#paper');
  await page.getByRole('button', { name: 'Markdown 源码', exact: true }).click();
  const source = page.getByRole('textbox', { name: 'Markdown 源码', exact: true });
  await source.fill('# 首次新正文'); await page.getByRole('button', { name: /保存正文/ }).click();
  await expect(page.locator('.paper-footer')).toContainText(`版本 ${(await (await request.get('/api/snapshot')).json()).document.version}`);
  await expect(source).toHaveValue('# 首次新正文');
  await source.fill('# 连续第二次保存'); await page.getByRole('button', { name: /保存正文/ }).click();
  await expect(page.getByRole('status').filter({ hasText: '已保存到本机' })).toBeVisible();
  expect((await (await request.get('/api/snapshot')).json()).document.markdown).toBe('# 连续第二次保存');
});

test('closing an inactive tab cannot bypass draft confirmation on browser back', async ({ page, request }) => {
  const { wid, a, b } = await fixture(request); await page.goto(`/#wiki/${wid}/${a}`);
  const tabs = page.getByRole('tablist', { name: '已打开条目', exact: true }), active = page.locator('.wiki-entry:not([hidden])');
  await page.locator('.wiki-results').getByRole('button', { name: /^乙页/ }).click({ modifiers: ['Control'] });
  await tabs.getByRole('tab', { name: '甲页', exact: true }).click();
  await active.getByRole('button', { name: '正文源码', exact: true }).click();
  const source = active.getByRole('textbox', { name: '条目Markdown源码', exact: true }); await source.fill('不能丢失的草稿');
  await tabs.getByRole('button', { name: '关闭乙页', exact: true }).click(); await expect(tabs.getByRole('tab')).toHaveCount(1);
  let dialogs = 0; page.on('dialog', async dialog => { dialogs++; await dialog.dismiss(); });
  await page.goBack(); await expect(page).toHaveURL(new RegExp(`${a}$`)); expect(dialogs).toBe(1);
  await expect(source).toHaveValue('不能丢失的草稿'); await expect(tabs.getByRole('tab', { name: '乙页', exact: true })).toHaveCount(0);
});

test('closing the active and then final tab keeps the hash synchronized without reopening either tab', async ({ page, request }) => {
  const { wid, a } = await fixture(request); await page.goto(`/#wiki/${wid}/${a}`);
  const tabs = page.getByRole('tablist', { name: '已打开条目', exact: true });
  await page.locator('.wiki-results').getByRole('button', { name: /^乙页/ }).click({ modifiers: ['Control'] });
  await tabs.getByRole('button', { name: '关闭乙页', exact: true }).click();
  await expect(tabs.getByRole('tab')).toHaveCount(1); await expect(tabs.getByRole('tab', { name: '甲页', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page).toHaveURL(new RegExp(`${a}$`));
  await tabs.getByRole('button', { name: '关闭甲页', exact: true }).click(); await expect(tabs.getByRole('tab')).toHaveCount(0);
  await expect(page).toHaveURL(new RegExp(`#wiki/${wid}$`)); await page.reload(); await expect(tabs.getByRole('tab')).toHaveCount(0);
});

test('relation definition saves freeze the entire form and selection until its result arrives', async ({ page, request }) => {
  const { wid } = await fixture(request), ids: string[] = [];
  for (const name of ['定义甲', '定义乙']) { const result = relationDefinitionCommand((await snapshot(request)).state, wid, name, []); await execute(request, result.command); ids.push(result.id); }
  await page.goto(`/#wiki/${wid}/${wid}`); await page.getByRole('button', { name: '关系定义', exact: true }).click();
  const panel = page.getByRole('region', { name: '关系定义管理', exact: true }); await panel.getByRole('button', { name: '定义甲', exact: true }).click();
  await panel.getByRole('textbox', { name: '关系定义名称', exact: true }).fill('定义甲已改');
  await panel.getByText('新附加字段的初始值（可选）', { exact: true }).click();
  const held = await holdCommand(page);
  try {
    await panel.getByRole('button', { name: '保存关系定义', exact: true }).click(); await held.seen;
    await expect(panel.getByRole('button', { name: '定义乙', exact: true })).toBeDisabled();
    await expect(panel.getByRole('textbox', { name: '关系定义名称', exact: true })).toBeDisabled();
    await expect(panel.getByRole('textbox', { name: '关系字段初始值', exact: true })).toBeDisabled();
  } finally { held.release(); }
  await expect(panel.getByRole('status')).toContainText('关系定义已保存');
  await panel.getByRole('button', { name: '定义乙', exact: true }).click(); await expect(panel.getByRole('textbox', { name: '关系定义名称', exact: true })).toHaveValue('定义乙');
  await panel.getByRole('textbox', { name: '关系定义名称', exact: true }).fill('定义乙已改'); await panel.getByRole('button', { name: '保存关系定义', exact: true }).click();
  await expect(panel.getByRole('status')).toContainText('关系定义已保存');
  const { state } = await snapshot(request); expect(ids.map(id => titleOf(state, state.objects.find(o => o.id === id)!))).toEqual(['定义甲已改', '定义乙已改']);
});

test('space saves freeze text, path and file inputs then allow a new draft after completion', async ({ page, request }) => {
  const { wid } = await fixture(request); await page.goto(`/#wiki/${wid}/${wid}`); await page.getByRole('button', { name: '空间', exact: true }).click();
  const text = page.getByRole('textbox', { name: '粘贴资料文字', exact: true }); await text.fill('本次提交'); const held = await holdCommand(page);
  try {
    await page.getByRole('button', { name: '保存资料', exact: true }).click(); await held.seen;
    await expect(text).toBeDisabled(); await expect(page.getByLabel('上传资料文件', { exact: true })).toBeDisabled();
    await expect(page.getByRole('textbox', { name: '资料保存路径', exact: true })).toBeDisabled();
  } finally { held.release(); }
  await expect(text).toBeEnabled(); await expect(text).toHaveValue(''); await text.fill('下一份草稿'); await expect(text).toHaveValue('下一份草稿');
  const { state } = await snapshot(request); const resource = state.resources.find(r => r.worldId === wid && r.path === '资料/笔记.md')!;
  expect(Buffer.from(state.resourceVersions.find(v => v.id === resource.id)!.content, 'base64').toString()).toBe('本次提交');
});

for (const world of [true, false]) test(`creation locks the submitted draft until completion, world=${world}`, async ({ page, request }) => {
  if (world) { const { wid } = await fixture(request); await page.goto(`/#wiki/${wid}/${wid}`); await page.getByRole('button', { name: '新建条目', exact: true }).click(); await page.getByRole('button', { name: '创建世界', exact: true }).click(); }
  else { const { wid } = await fixture(request); await page.goto(`/#wiki/${wid}/${wid}`); await page.getByRole('button', { name: '新建条目', exact: true }).click(); }
  const name = page.getByRole('textbox', { name: world ? '新世界名称' : '新内容名称', exact: true }); await name.fill('本次创建'); const held = await holdCommand(page);
  if (world) {
    await page.getByLabel('创建世界的已有资料', { exact: true }).setInputFiles({ name: '原始资料.txt', mimeType: 'text/plain', buffer: Buffer.from('原始资料') });
    await page.evaluate(() => {
      const original = File.prototype.arrayBuffer;
      File.prototype.arrayBuffer = function () {
        const state = window as unknown as { fileReadStarted: boolean; finishFileRead(): void }; state.fileReadStarted = true;
        return new Promise(resolve => { state.finishFileRead = async () => resolve(await original.call(this)); });
      };
    });
  }
  try {
    await page.getByRole('button', { name: world ? '保存世界草案' : '保存新内容', exact: true }).click();
    if (world) {
      await page.waitForFunction(() => (window as unknown as { fileReadStarted: boolean }).fileReadStarted);
      await expect(page.getByRole('button', { name: '创建世界', exact: true })).toBeDisabled();
      await expect(page.getByRole('textbox', { name: '新内容名称', exact: true })).toBeDisabled();
      await expect(page.getByRole('button', { name: '保存新内容', exact: true })).toBeDisabled();
      await page.evaluate(() => (window as unknown as { finishFileRead(): void }).finishFileRead());
    }
    await held.seen;
    await expect(name).toBeDisabled();
    await expect(page.getByRole('button', { name: '创建世界', exact: true })).toBeDisabled();
    if (!world) for (const label of ['新建条目', '新建关系', '新建文件夹']) await expect(page.getByRole('button', { name: label, exact: true })).toBeDisabled();
    if (world) { await expect(page.getByRole('textbox', { name: '世界初始想法', exact: true })).toBeDisabled(); await expect(page.getByLabel('创建世界的已有资料', { exact: true })).toBeDisabled(); }
    else await expect(page.locator('.wiki-create').getByRole('button', { name: '取消', exact: true })).toBeDisabled();
  } finally { held.release(); }
  await expect(name).toHaveCount(0); const id = page.url().split('/').at(-1)!; const { state } = await snapshot(request);
  expect(titleOf(state, state.objects.find(o => o.id === id)!)).toBe('本次创建');
});

test('field definition selection and inputs are locked during its save', async ({ page, request }) => {
  const { wid } = await fixture(request); await page.goto(`/#wiki/${wid}/${wid}`); await page.getByRole('button', { name: '字段定义', exact: true }).click();
  const panel = page.locator('.wiki-definition-panel').filter({ has: page.getByRole('textbox', { name: '字段定义名称', exact: true }) });
  await panel.getByRole('textbox', { name: '字段定义名称', exact: true }).fill('延迟字段'); const held = await holdCommand(page);
  try {
    await panel.getByRole('button', { name: '保存字段定义', exact: true }).click(); await held.seen;
    await expect(panel.getByRole('button', { name: '新建字段定义', exact: true })).toBeDisabled();
    for (const label of ['字段定义名称', '字段用途说明', '字段约束']) await expect(panel.getByRole('textbox', { name: label, exact: true })).toBeDisabled();
    await expect(panel.getByRole('combobox', { name: '字段定义类型', exact: true })).toBeDisabled();
  } finally { held.release(); }
  await expect(panel.getByRole('status')).toContainText('字段定义已保存');
  expect((await snapshot(request)).state.definitions.some(d => d.name === '延迟字段')).toBe(true);
});
