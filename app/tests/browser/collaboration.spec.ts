import { test, expect } from '@playwright/test';
import { command, newWorld } from '../../client/wiki.ts';
import type { CollaborationView } from '../../contracts/collaboration.ts';
import type { WorkspaceView } from '../../contracts/workspace.ts';

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
