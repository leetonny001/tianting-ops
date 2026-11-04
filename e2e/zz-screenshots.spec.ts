import { expect, test } from '@playwright/test';
import { clockNow, control, login, probe, provision } from './helpers';

// 人工看样式用：SHOTS=目录 npx playwright test e2e/zz-screenshots.spec.ts
test.skip(!process.env.SHOTS, 'SHOTS=dir 才截图');
test('screens', async ({ page }) => {
  const dir = process.env.SHOTS!;
  await control('/fake', {
    alerts: [
      { labels: { alertname: 'HighErrorRate', severity: 'critical', node_id: 'n1' }, startsAt: '2026-11-04T00:00:00Z' },
    ],
  });
  const e = await provision('zhiban', 'ops_engineer');
  await control('/manifest', {
    source: 'im',
    result: 'success',
    trigger: 'schedule',
    finishedAt: clockNow() - 600_000,
    file: 'im-20261104.db.age',
    size: 12_000_000,
    verified: true,
    encrypted: true,
    uploaded: true,
  });
  await login(page, e);
  await probe();
  await page.reload();
  await expect(page.getByRole('region', { name: '服务状态' })).toBeVisible();
  await page.screenshot({ path: `${dir}/overview.png`, fullPage: true });
  await page.setViewportSize({ width: 375, height: 800 });
  await page.screenshot({ path: `${dir}/overview-375.png`, fullPage: true });
  await page.setViewportSize({ width: 1280, height: 800 });
  await probe();
  await page.goto('/nodes');
  await expect(page.getByRole('cell', { name: 'n1', exact: true })).toBeVisible();
  await page.screenshot({ path: `${dir}/nodes.png` });
  await page.goto('/config');
  await expect(page.getByRole('heading', { name: '节点 n1' })).toBeVisible();
  await page.screenshot({ path: `${dir}/config.png` });
});
