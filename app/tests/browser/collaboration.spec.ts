import { test, expect } from '@playwright/test';
import { command, newWorld } from '../../client/wiki.ts';
import { operations, type CollaborationView } from '../../contracts/collaboration.ts';
import type { WorkspaceView, DefinitionInput } from '../../contracts/workspace.ts';

test('visible collaboration controls keep default and session policies separate and persist them', async ({ page, request }) => {
  await page.goto('/'); await page.getByRole('button', { name: '协作设置与任务', exact: true }).click();
  const panel = page.getByRole('region', { name: '协作设置与任务', exact: true });
  await expect(panel.getByText('尚未确认协作设置。以下只是可调整的起点，保存后才采用。', { exact: true })).toBeVisible();
  await panel.getByRole('combobox', { name: '协作主动性', exact: true }).selectOption('suggest');
  await panel.getByRole('combobox', { name: '协作操作权限', exact: true }).selectOption('allow');
  await panel.getByRole('combobox', { name: '协作创作参与度', exact: true }).selectOption('expand');
  await panel.getByRole('button', { name: '保存协作设置', exact: true }).click(); await expect(panel.getByRole('status')).toContainText('协作设置已保存');
  await panel.getByRole('textbox', { name: '新协作会话名称', exact: true }).fill('独立会话'); await panel.getByRole('button', { name: '新建协作会话', exact: true }).click();
  await expect(panel.getByRole('combobox', { name: '协作设置范围', exact: true })).not.toHaveValue('');
  await panel.getByRole('combobox', { name: '协作操作权限', exact: true }).selectOption('deny'); await panel.getByRole('button', { name: '保存协作设置', exact: true }).click();
  await expect(panel.getByRole('status')).toContainText('协作设置已保存');
  await panel.getByRole('combobox', { name: '协作设置范围', exact: true }).selectOption('');
  await expect(panel.getByRole('combobox', { name: '协作操作权限', exact: true })).toHaveValue('allow');
  const view: CollaborationView = await (await request.get('/api/agent/state')).json(); expect(view.defaults.permissions.modify).toBe('allow'); expect(view.sessions.find(s => s.name === '独立会话')!.policy.permissions.modify).toBe('deny');
  await page.reload(); await page.getByRole('button', { name: '协作设置与任务', exact: true }).click(); await expect(panel.getByRole('combobox', { name: '协作主动性', exact: true })).toHaveValue('suggest');
  await page.setViewportSize({ width: 390, height: 844 }); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('protected content waits for explicit task approval and records one real authorized commit', async ({ page, request }) => {
  const before: WorkspaceView = await (await request.get('/api/core/snapshot')).json(), world = newWorld(before.state, '保护验证', '');
  expect((await request.post('/api/core/commands', { data: world.command })).ok()).toBe(true);
  await page.goto('/'); await page.getByRole('button', { name: '协作设置与任务', exact: true }).click();
  const panel = page.getByRole('region', { name: '协作设置与任务', exact: true });
  await panel.getByRole('combobox', { name: '协作设置范围', exact: true }).selectOption('');
  await panel.getByRole('combobox', { name: '协作操作权限', exact: true }).selectOption('allow'); await panel.getByRole('button', { name: '保存协作设置', exact: true }).click(); await expect(panel.getByRole('status')).toContainText('协作设置已保存');
  await panel.getByRole('textbox', { name: '新协作会话名称', exact: true }).fill('受保护任务'); await panel.getByRole('button', { name: '新建协作会话', exact: true }).click(); await expect(panel.getByRole('combobox', { name: '协作设置范围', exact: true })).not.toHaveValue('');
  await panel.getByRole('combobox', { name: '保护内容', exact: true }).selectOption(world.worldId); await panel.getByRole('button', { name: '保护所选内容', exact: true }).click(); await expect(panel.getByRole('status')).toContainText('内容保护已保存');
  let view: CollaborationView = await (await request.get('/api/agent/state')).json(); const session = view.sessions.find(s => s.name === '受保护任务')!;
  const state: WorkspaceView = await (await request.get('/api/core/snapshot')).json(), object = state.state.objects.find(o => o.id === world.worldId)!;
  const field = state.state.definitions.find(d => d.marks.includes('title') && d.id in object.fields)!.id;
  const taskId = crypto.randomUUID();
  expect((await request.post('/api/agent/actions', { data: { type: 'task.enqueue', id: taskId, sessionId: session.id, title: '获准后改名', intent: 'change', reads: [], command: command(state.state, world.worldId, [{ type: 'object.update', id: world.worldId, set: { [field]: ['明确授权后的名称'] } }]) } })).ok()).toBe(true);
  const card = panel.getByRole('article').filter({ hasText: '获准后改名' }); await expect(card).toContainText('等待授权'); await expect(card).toContainText('内容受保护'); await expect(card).toContainText('明确授权后的名称');
  expect((await (await request.get('/api/core/snapshot')).json()).state.revision).toBe(state.state.revision);
  await card.getByRole('button', { name: '仅授权本任务列出的操作', exact: true }).click(); await expect(card).toContainText('已完成');
  const after: WorkspaceView = await (await request.get('/api/core/snapshot')).json(); expect(after.state.revision).toBe(state.state.revision + 1); expect(after.history.filter(h => h.taskId === taskId)).toHaveLength(1); expect(after.history[0]!.actor).toBe('agent');
  view = await (await request.get('/api/agent/state')).json(); expect(view.protections.some(p => p.enabled && p.target.id === world.worldId)).toBe(true);
  await page.screenshot({ path: 'test-results/collaboration-approved.png', fullPage: true });
});


test('creating a session asks before discarding settings and cancelling keeps both draft and session name', async ({ page, request }) => {
  const before: CollaborationView = await (await request.get('/api/agent/state')).json();
  const saved = before.defaults.permissions.modify, draft = saved === 'deny' ? 'ask' : 'deny';
  await page.goto('/'); await page.getByRole('button', { name: '协作设置与任务', exact: true }).click();
  const panel = page.getByRole('region', { name: '协作设置与任务', exact: true });
  await panel.getByRole('combobox', { name: '协作操作权限', exact: true }).selectOption(draft);
  await panel.getByRole('textbox', { name: '新协作会话名称', exact: true }).fill('草稿保护会话');
  page.once('dialog', async d => { expect(d.message()).toContain('采用已保存的默认设置'); await d.dismiss(); });
  await panel.getByRole('button', { name: '新建协作会话', exact: true }).click();
  await expect(panel.getByRole('combobox', { name: '协作操作权限', exact: true })).toHaveValue(draft);
  await expect(panel.getByRole('textbox', { name: '新协作会话名称', exact: true })).toHaveValue('草稿保护会话');
  expect((await (await request.get('/api/agent/state')).json()).sessions).toHaveLength(before.sessions.length);
  page.once('dialog', async d => { expect(d.message()).toContain('放弃当前修改'); await d.accept(); });
  await panel.getByRole('button', { name: '新建协作会话', exact: true }).click();
  await expect(panel.getByRole('combobox', { name: '协作设置范围', exact: true })).not.toHaveValue('');
  const after: CollaborationView = await (await request.get('/api/agent/state')).json();
  expect(after.defaults).toEqual(before.defaults); expect(after.sessions.find(s => s.name === '草稿保护会话')!.policy.permissions.modify).toBe(saved);
});

test('field approval shows old and new rules, scope and both affected worlds before one atomic application', async ({ page, request }) => {
  const snapshot = async (): Promise<WorkspaceView> => (await request.get('/api/core/snapshot')).json();
  const a = newWorld((await snapshot()).state, '规则审查甲', ''); expect((await request.post('/api/core/commands', { data: a.command })).ok()).toBe(true);
  const b = newWorld((await snapshot()).state, '规则审查乙', ''); expect((await request.post('/api/core/commands', { data: b.command })).ok()).toBe(true);
  const fieldId = crypto.randomUUID();
  const old = { id: fieldId, scope: 'global', name: '共用评语', type: 'choice' as const, marks: [], constraints: { options: ['alpha', 'beta'], maxCount: 1 } };
  let state = (await snapshot()).state;
  expect((await request.post('/api/core/commands', { data: command(state, a.worldId, [{ type: 'definition.put', definition: old }, { type: 'object.update', id: a.worldId, set: { [fieldId]: ['alpha'] } }, { type: 'object.update', id: b.worldId, set: { [fieldId]: ['beta'] } }]) })).ok()).toBe(true);
  state = (await snapshot()).state;
  const sessionId = crypto.randomUUID(), id = crypto.randomUUID();
  expect((await request.post('/api/agent/actions', { data: { type: 'session.create', id: sessionId, name: '规则授权会话' } })).ok()).toBe(true);
  expect((await request.post('/api/agent/actions', { data: { type: 'policy.update', sessionId, expectedVersion: 0, policy: { configured: true, initiative: 'respond', contribution: 'organize', permissions: Object.fromEntries(operations.map(o => [o, 'ask'])) } } })).ok()).toBe(true);
  const next = { ...old, name: '共用描述', type: 'text', marks: ['summary'], constraints: { required: true, maxCount: 2, maxLength: 12345 }, comment: '改用可编辑的文字' } satisfies DefinitionInput;
  expect((await request.post('/api/agent/actions', { data: { type: 'task.enqueue', sessionId, id, title: '检查字段完整预览', intent: 'change', reads: [], command: command(state, a.worldId, [{ type: 'definition.put', definition: next }]) } })).ok()).toBe(true);
  await page.goto('/'); await page.getByRole('button', { name: '协作设置与任务', exact: true }).click();
  const card = page.getByRole('article').filter({ hasText: '检查字段完整预览' }); await expect(card).toContainText('等待授权');
  const preview = card.getByRole('region', { name: '字段规则变更：共用描述', exact: true });
  await expect(preview).toContainText('最长文字长度：12345'); await expect(preview).toContainText('必须有值：是');
  await expect(preview.getByRole('row', { name: /取值类型/ })).toContainText('选项'); await expect(preview.getByRole('row', { name: /取值类型/ })).toContainText('文字');
  await expect(preview).toContainText('摘要'); await expect(preview).toContainText('全局（各世界共用定义）'); await expect(preview).toContainText('2项内容，涉及2个世界');
  await expect(preview).toContainText('规则审查甲'); await expect(preview).toContainText('规则审查乙'); await expect(preview).toContainText('共用评语');
  expect((await snapshot()).state.revision).toBe(state.revision);
  await page.setViewportSize({ width: 390, height: 844 }); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/field-rule-preview-fixed.png', fullPage: true });
  await card.getByRole('button', { name: '仅授权本任务列出的操作', exact: true }).click(); await expect(card).toContainText('已完成');
  const after = await snapshot(); expect(after.state.revision).toBe(state.revision + 1); expect(after.history.filter(h => h.taskId === id)).toHaveLength(1);
  expect(after.state.definitions.find(d => d.id === fieldId)!.constraints.maxLength).toBe(12345);
});

test('manual saves refresh protection choices without closing the panel or losing settings and selections', async ({ page, request }) => {
  const before: WorkspaceView = await (await request.get('/api/core/snapshot')).json();
  await page.goto('/'); await page.getByRole('button', { name: '协作设置与任务', exact: true }).click();
  const panel = page.getByRole('region', { name: '协作设置与任务', exact: true });
  const selected = before.state.worlds[0]!.rootId;
  await panel.getByRole('combobox', { name: '保护内容', exact: true }).selectOption(selected);
  await panel.getByRole('combobox', { name: '协作主动性', exact: true }).selectOption('advance');
  const wiki = page.getByRole('region', { name: '手工Wiki', exact: true });
  await wiki.getByRole('button', { name: '创建世界', exact: true }).click();
  await page.getByRole('textbox', { name: '新世界名称', exact: true }).fill('面板打开期间创建');
  await page.getByRole('button', { name: '保存世界草案', exact: true }).click();
  const newChoice = panel.getByRole('combobox', { name: '保护内容', exact: true }).getByRole('option', { name: /面板打开期间创建/ });
  await expect(newChoice).toHaveCount(1); await expect(panel.getByRole('combobox', { name: '保护内容', exact: true })).toHaveValue(selected);
  await expect(panel.getByRole('combobox', { name: '协作主动性', exact: true })).toHaveValue('advance');
  const created: WorkspaceView = await (await request.get('/api/core/snapshot')).json();
  const field = created.state.definitions.find(d => d.marks.includes('title') && d.id in created.state.objects.find(o => o.id === selected)!.fields)!.id;
  expect((await request.post('/api/core/commands', { data: command(created.state, selected, [{ type: 'object.update', id: selected, set: { [field]: ['另一个页面改过的名称'] } }]) })).ok()).toBe(true);
  await panel.getByRole('button', { name: '重新读取资料', exact: true }).click();
  await expect(panel.getByRole('combobox', { name: '保护内容', exact: true }).locator(`option[value="${selected}"]`)).toContainText('另一个页面改过的名称');
  await expect(panel.getByRole('combobox', { name: '协作主动性', exact: true })).toHaveValue('advance');
});
