import { test, expect } from '@playwright/test';

test('real Milkdown editing/Markdown round trip, persisted assistant-ui stream and responsive layout', async ({ page, request }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await expect(page.getByText('本机服务已连接')).toBeVisible();
  const editor = page.locator('.milkdown .ProseMirror');
  await expect(editor).toBeVisible();
  await page.screenshot({ path: 'test-results/workbench-desktop.png', fullPage: true });

  await editor.click();
  await page.keyboard.press('Control+End');
  await page.keyboard.press('Enter');
  await page.keyboard.insertText('浏览器真实编辑：你好，雾海。');
  await page.getByRole('button', { name: /保存正文/ }).click();
  await expect(page.getByRole('status').filter({ hasText: '已保存到本机' })).toBeVisible();
  await page.reload();
  await expect(editor).toContainText('浏览器真实编辑：你好，雾海。');

  await page.getByRole('button', { name: 'Markdown 源码', exact: true }).click();
  const sample = '# 往返验收\n\n中文、**粗体**、[安全链接](https://example.com)。\n\n[[entry-123|旧灯塔]]\n\n- 一\n- 二\n\n| 地点 | 状态 |\n| --- | --- |\n| 港口 | 未定 |\n\n```ts\nconst value = 42;\n```\n';
  await page.getByRole('textbox', { name: 'Markdown 源码', exact: true }).fill(sample);
  await page.getByRole('button', { name: '编辑', exact: true }).click();
  await expect(editor).toContainText('旧灯塔');
  await page.getByRole('button', { name: /保存正文/ }).click();
  await expect(page.getByRole('status').filter({ hasText: '已保存到本机' })).toBeVisible();
  const saved = (await (await request.get('/api/snapshot')).json()).document.markdown;
  expect(saved).toContain('[[entry-123|旧灯塔]]');
  expect(saved).toContain('**粗体**');
  expect(saved).toContain('const value = 42;');
  expect(saved).toContain('| 港口');
  await page.getByRole('button', { name: '阅读', exact: true }).click();
  await expect(page.locator('.markdown-body h1')).toHaveText('往返验收');
  await expect(page.locator('.markdown-body table')).toContainText('港口');

  await page.getByRole('textbox', { name: '发送给演示助手' }).fill('如果灯塔记住每一个过客');
  await page.getByRole('button', { name: '发送消息' }).click();
  await expect(page.getByRole('button', { name: '继续任务 →' })).toBeVisible();
  await expect(page.locator('.assistant-message')).toContainText('第一步已完成');
  await page.reload();
  await expect(page.getByRole('button', { name: '继续任务 →' })).toBeVisible();
  await page.getByRole('button', { name: '继续任务 →' }).click();
  await expect(page.getByRole('region', { name: '任务进度', exact: true })).toContainText('已完成');
  await expect(page.getByRole('progressbar', { name: '演示任务进度' })).toHaveAttribute('value', '100');
  await expect(page.locator('.assistant-message')).toContainText('任务已从保存的位置继续并完成');
  await expect(page.locator('.user-message')).toHaveCount(1);
  await expect(page.locator('.assistant-message')).toHaveCount(1);
  await page.getByRole('button', { name: /收起助手/ }).click();
  await expect(page.getByLabel('演示助手', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: /展开助手/ }).click();
  await expect(page.locator('.assistant-message')).toHaveCount(1);

  await page.getByRole('button', { name: 'Markdown 源码', exact: true }).click();
  await page.getByRole('textbox', { name: 'Markdown 源码', exact: true }).fill('# 安全渲染\n\n<script>window.__unsafe=1</script>\n\n[危险链接](javascript:alert(1))');
  await page.getByRole('button', { name: '阅读', exact: true }).click();
  expect(await page.evaluate(() => (window as any).__unsafe)).toBeUndefined();
  await expect(page.locator('.markdown-body script')).toHaveCount(0);
  await expect(page.locator('.markdown-body a[href^="javascript:"]')).toHaveCount(0);
  await page.getByRole('button', { name: /保存正文/ }).click();

  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => window.scrollTo(0, 0));
  await expect(page.getByRole('link', { name: '进入 S1.2 数据验证' })).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/workbench-mobile.png', fullPage: true });
  expect(errors).toEqual([]);
});

test('external save during the Markdown debounce window does not erase local typing', async ({ page, request }) => {
  await page.goto('/');
  const editor = page.locator('.milkdown .ProseMirror'); await expect(editor).toBeVisible();
  const before = (await (await request.get('/api/snapshot')).json()).document;
  await page.clock.install(); await page.clock.pauseAt(new Date());
  await editor.click(); await page.keyboard.press('Control+End');
  await page.keyboard.insertText('尚未通知页面的新输入');
  const remote = await request.put('/api/demo/document', { data: { markdown: '# 其他页面已保存', version: before.version } });
  expect(remote.ok()).toBe(true);
  await page.clock.runFor(250);
  await expect(editor).toContainText('尚未通知页面的新输入');
  await page.getByRole('button', { name: /保存正文/ }).click();
  await expect(page.getByRole('alert')).toContainText('其他页面');
  await expect(editor).toContainText('尚未通知页面的新输入');
});

test('S1.2 browser example stores both worlds, rejects incomplete migration and deduplicates', async ({ page, request }) => {
  const before = await (await request.get('/api/core/snapshot')).json();
  const revision = before.state.revision;
  await page.goto('/');
  await page.getByRole('button', { name: 'Markdown 源码', exact: true }).click();
  await page.getByRole('textbox', { name: 'Markdown 源码', exact: true }).fill('# 切换入口仍保留的草稿');
  await page.getByRole('link', { name: '进入 S1.2 数据验证' }).click();
  await expect(page.getByRole('heading', { name: '数据验证台', exact: true })).toBeVisible();
  await expect(page).toHaveURL(/#data$/);
  await page.getByRole('button', { name: '返回创作纸', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Markdown 源码', exact: true })).toHaveValue('# 切换入口仍保留的草稿');
  await page.goBack();
  await expect(page.getByRole('heading', { name: '数据验证台', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '新增一组验证资料' }).click();
  await expect(page.locator('.data-summary')).toContainText(`${before.state.worlds.length + 2} 个世界`);
  await page.getByRole('button', { name: '尝试不完整转换' }).click();
  await expect(page.locator('.data-message')).toContainText('未保存');
  await expect(page.locator('.data-summary')).toContainText(`版本 ${revision + 1}`);
  await page.getByRole('button', { name: '一起转换定义和值' }).click();
  await expect(page.locator('.data-summary')).toContainText(`版本 ${revision + 2}`);
  await page.getByRole('button', { name: '重复上次请求' }).click();
  await expect(page.locator('.data-message')).toContainText('没有新增');
  await page.reload();
  await expect(page.getByRole('heading', { name: '数据验证台', exact: true })).toBeVisible();
  await expect(page.locator('.data-summary')).toContainText(`版本 ${revision + 2}`);
  const snapshot = await (await request.get('/api/core/snapshot')).json();
  expect(snapshot.history).toHaveLength(before.history.length + 2); expect(snapshot.state.worlds).toHaveLength(before.state.worlds.length + 2);
  await page.goto('/#data');
  await expect(page.locator('.data-summary')).toContainText(`版本 ${revision + 2}`);
  await page.screenshot({ path: 'test-results/data-workbench.png', fullPage: true });
});

test('a separately served frontend can call the API origin and subscribe to events directly', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByText('本机服务已连接')).toBeVisible();
  const result = await page.evaluate(async () => {
    const base = 'http://127.0.0.1:4330';
    const snapshot = await (await fetch(base + '/api/snapshot')).json();
    const saved = await fetch(base + '/api/demo/document', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ markdown: '# 跨端口接口验证', version: snapshot.document.version }) });
    const eventId = await new Promise<number>((resolve, reject) => {
      const events = new EventSource(base + '/api/events');
      const timer = setTimeout(() => { events.close(); reject(new Error('SSE未连通')); }, 5000);
      events.addEventListener('snapshot', event => { clearTimeout(timer); events.close(); resolve(JSON.parse(event.data).eventId); });
    });
    return { status: saved.status, eventId };
  });
  expect(result.status).toBe(200); expect(result.eventId).toBeGreaterThan(0);
});
