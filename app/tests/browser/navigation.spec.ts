import { test, expect } from '@playwright/test';

test('the default page opens worlds and visible navigation works at desktop, tablet and phone widths', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '我的世界', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '创建世界', exact: true })).toBeVisible();
  const navigation = page.getByRole('navigation', { name: '主要功能', exact: true });
  for (const width of [1440, 800, 390]) {
    await page.setViewportSize({ width, height: 844 });
    for (const name of ['我的世界 / Wiki', '数据验证', '创作纸演示']) await expect(navigation.getByRole('link', { name, exact: true })).toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await navigation.getByRole('link', { name: '数据验证', exact: true }).click();
    await expect(page.getByRole('heading', { name: '数据验证台', exact: true })).toBeVisible();
    await navigation.getByRole('link', { name: '我的世界 / Wiki', exact: true }).click();
    await expect(page.getByRole('heading', { name: '我的世界', exact: true })).toBeVisible();
  }
  await navigation.getByRole('link', { name: '创作纸演示', exact: true }).click();
  await page.getByRole('button', { name: 'Markdown 源码', exact: true }).click();
  await page.getByRole('textbox', { name: 'Markdown 源码', exact: true }).fill('切换功能入口仍保留这份草稿');
  await navigation.getByRole('link', { name: '我的世界 / Wiki', exact: true }).click();
  await navigation.getByRole('link', { name: '创作纸演示', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Markdown 源码', exact: true })).toHaveValue('切换功能入口仍保留这份草稿');
});

test('a rebuilt frontend offers a refresh while preserving unsaved text until the user chooses', async ({ page, request }) => {
  const version = await request.get('/web-version.json'); expect(version.ok()).toBe(true);
  expect((await version.json()).buildId).toMatch(/^[0-9a-f-]{36}$/);
  expect(version.headers()['cache-control']).toContain('no-cache');
  const firstCheck = page.waitForResponse('**/web-version.json');
  await page.goto('/#paper'); await firstCheck;
  await expect(page.getByRole('button', { name: '刷新使用新版', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Markdown 源码', exact: true }).click();
  const text = page.getByRole('textbox', { name: 'Markdown 源码', exact: true });
  await text.fill('尚未保存，不能因发布新版而丢掉');
  await page.route('**/web-version.json', route => route.fulfill({ json: { buildId: '00000000-0000-4000-8000-000000000099' } }));
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  const refresh = page.getByRole('button', { name: '刷新使用新版', exact: true });
  await expect(refresh).toBeVisible(); await expect(text).toHaveValue('尚未保存，不能因发布新版而丢掉');
  page.once('dialog', dialog => dialog.dismiss());
  await refresh.click(); await expect(text).toHaveValue('尚未保存，不能因发布新版而丢掉');
  await page.unroute('**/web-version.json');
});

test('worlds remain reachable if the separate demo snapshot is unavailable', async ({ page }) => {
  await page.route('**/api/snapshot', route => route.abort());
  await page.route('**/api/events', route => route.abort());
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '我的世界', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '创建世界', exact: true })).toBeVisible();
});
