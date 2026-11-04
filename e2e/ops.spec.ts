import { expect, test } from '@playwright/test';
import {
  clockNow,
  pauseNode,
  resumeNode,
  control,
  dial,
  forceLogout,
  freshOtp,
  login,
  loginApi,
  probe,
  provision,
  REASON,
  root,
  rootAccount,
  TICKET,
  tick,
  totp,
  PASSWORD,
  uid,
  watchPage,
} from './helpers';

async function query(page: import('@playwright/test').Page, userId: string, ticket = TICKET, reason = REASON) {
  await page.getByLabel('userId').fill(userId);
  await page.getByLabel('工单号').fill(ticket);
  await page.getByLabel('理由').fill(reason);
  await page.getByRole('button', { name: '查询', exact: true }).click();
}

test('还没有账号时提示用命令行创建；激活流程（AC-OPS-01-5）', async ({ page }) => {
  const problems = watchPage(page);
  await page.goto('/login');
  if (await page.getByText('运维空间还没有账号').count()) {
    await expect(page.getByText('console-server account bootstrap --space ops')).toBeVisible();
  }
  await root();
  await page.goto('/login');
  await expect(page.getByText('运维空间还没有账号')).toHaveCount(0);

  const r = await root();
  await r.call('POST', '/console/api/auth/step-up', { otp: await freshOtp(rootAccount().seed) });
  const name = uid('neweng');
  const { activationCode } = await r.call<{ activationCode: string }>('POST', '/console/api/accounts', {
    username: name,
    displayName: name,
    roles: ['ops_engineer'],
  });
  await page.goto('/activate');
  await page.getByLabel('账号').fill(name);
  await page.getByLabel('激活码').fill(activationCode);
  await page.getByLabel('新密码').fill(PASSWORD);
  await page.getByLabel('再输一次').fill(PASSWORD);
  await page.getByRole('button', { name: '激活' }).click();
  // 二维码是内联 SVG：CSP 不允许 data: 图片。
  await expect(page.getByRole('img', { name: '二次验证二维码' })).toBeVisible();
  await page.goto('/troubleshoot');
  await expect(page).toHaveURL(/\/setup$/);
  const secret = await page.getByTestId('totp-secret').innerText();
  await tick();
  await page.getByLabel('动态码').fill(totp(secret));
  await page.getByRole('button', { name: '绑定' }).click();
  await page.getByLabel('我已保存').check();
  await page.getByRole('button', { name: '完成' }).click();
  await expect(page.getByRole('heading', { name: '总览' })).toBeVisible();
  expect(problems).toEqual([]);
});

test('菜单和无权限页（AC-OPS-02-2）', async ({ page }) => {
  const v = await provision('view', 'ops_viewer');
  await login(page, v);
  const nav = page.getByRole('navigation', { name: '主菜单' });
  for (const name of ['连接排查', '审计日志', '账号管理']) await expect(nav.getByRole('link', { name })).toHaveCount(0);
  for (const name of ['总览', '节点', '配置检查', '数据库与备份'])
    await expect(nav.getByRole('link', { name })).toBeVisible();
  await expect(nav.getByRole('button', { name: '指标' })).toBeVisible();
  for (const p of ['/troubleshoot', '/audit', '/accounts']) {
    await page.goto(p);
    await expect(page.getByRole('heading', { name: '无权限' })).toBeVisible();
  }
  // 审计员和超管直接进自己的页面，没有总览和指标。
  const a = await provision('aud', 'ops_auditor');
  await page.getByRole('button', { name: '退出' }).click();
  await login(page, a);
  await expect(page).toHaveURL(/\/audit$/);
  await expect(nav.getByRole('link', { name: '总览' })).toHaveCount(0);
  await expect(nav.getByRole('button', { name: '指标' })).toHaveCount(0);
});

test('总览：卡片、数据不可用不显示 0、375px（AC-OPS-04-1、04-5、04-7、04-9、12-3）', async ({ page }) => {
  const problems = watchPage(page);
  await control('/fake', {
    promDown: false,
    amDown: false,
    alerts: [
      { labels: { alertname: 'HighErrorRate', severity: 'critical', node_id: 'n1' }, startsAt: '2026-11-04T00:00:00Z' },
    ],
  });
  await control('/manifests/clear');
  const v = await provision('view', 'ops_viewer');
  const u = uid('u');
  const a = await dial('n1', u, 'web');
  const b = await dial('n1', u, 'web');
  const c = await dial('n1', u, 'pc');
  await new Promise((r) => setTimeout(r, 100));
  await probe();
  await control('/manifest', {
    source: 'im',
    result: 'success',
    trigger: 'schedule',
    finishedAt: clockNow() - 60_000,
    file: 'a.db.age',
  });
  await login(page, v);
  // 登录推进了时钟（动态码）：再探测一轮，不然节点超过 15 秒没见过，算不可达。
  await probe();
  await page.reload();
  const card = (name: string) => page.getByRole('region', { name });
  await expect(card('服务状态')).toContainText('正常');
  await expect(card('节点数')).toContainText('2 / 2');
  await expect(card('在线连接')).toContainText('3');
  await expect(card('在线连接')).toContainText('web 2');
  await expect(card('在线连接')).toContainText('pc 1');
  await expect(card('消息量')).toContainText('10.0 条/秒');
  await expect(card('消息量')).toContainText('1,200');
  await expect(card('消息量')).toContainText('Asia/Shanghai');
  await expect(card('错误率')).toContainText('4xxx 30.0%');
  await expect(card('错误率')).toContainText('4290');
  await expect(card('错误率')).toContainText('不含 auth 和心跳');
  await expect(card('握手与断开')).toContainText('4011 × 5');
  await expect(card('告警')).toContainText('HighErrorRate');
  await expect(page.getByText(/数据时间/)).toBeVisible();

  // Prometheus、Alertmanager 挂了（AC-OPS-04-5、04-9）。
  await control('/fake', { promDown: true, amDown: true });
  await page.getByRole('button', { name: '刷新', exact: true }).click();
  for (const name of ['消息量', '错误率', '握手与断开']) {
    await expect(card(name)).toContainText('数据不可用');
    await expect(card(name)).not.toContainText('0.0');
  }
  await expect(card('告警')).toContainText('告警数据不可用');
  await expect(card('告警')).not.toContainText('当前没有告警');
  await expect(card('在线连接')).toContainText('3');
  await control('/fake', { promDown: false, amDown: false, alerts: [] });
  await page.getByRole('button', { name: '刷新', exact: true }).click();
  await expect(card('告警')).toContainText('当前没有告警');

  // 备份超过 2 小时标红（AC-OPS-12-3）。
  await expect(card('备份')).not.toContainText('超过 2 小时');
  await tick(2 * 3600_000 + 60_000);
  // 会话空闲 30 分钟过期：重新登录。备份缓存 30 秒，已经过了。
  await login(page, v);
  await expect(card('备份')).toContainText('超过 2 小时');
  await expect(card('备份')).toHaveClass(/card-bad/);

  // 375px（AC-OPS-04-7）。
  await page.setViewportSize({ width: 375, height: 800 });
  await expect(card('告警')).toBeVisible();
  for (const name of ['服务状态', '版本', '节点数', '在线连接', '消息量', '错误率', '握手与断开', '备份', '告警'])
    await expect(card(name)).toBeAttached();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
  await page.getByRole('link', { name: '节点', exact: true }).click();
  await expect(page.getByRole('cell', { name: 'n1', exact: true })).toBeVisible();
  const overflow2 = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow2).toBeLessThanOrEqual(0);
  [a, b, c].forEach((w) => w.close());
  expect(problems).toEqual([]);
});

test('自动刷新带后台头，手动刷新不带，页面不可见时暂停（FE-501）', async ({ page }) => {
  const v = await provision('view', 'ops_viewer');
  const seen: (string | undefined)[] = [];
  page.on('request', (r) => {
    if (r.url().endsWith('/ops/v1/overview')) seen.push(r.headers()['x-console-background']);
  });
  await page.clock.install();
  await login(page, v);
  await expect(page.getByRole('heading', { name: '总览' })).toBeVisible();
  await expect.poll(() => seen.length).toBeGreaterThan(0);
  const first = seen.length;
  await page.clock.fastForward(16_000);
  await expect.poll(() => seen.length).toBe(first + 1);
  expect(seen[first]).toBe('1');
  // 手动刷新不带。
  await page.getByRole('button', { name: '刷新', exact: true }).click();
  await expect.poll(() => seen.length).toBe(first + 2);
  expect(seen[first + 1]).toBeUndefined();
  // 暂停。
  await page.getByRole('button', { name: '暂停自动刷新' }).click();
  await page.clock.fastForward(40_000);
  await page.waitForTimeout(100);
  expect(seen.length).toBe(first + 2);
  await page.getByRole('button', { name: '恢复自动刷新' }).click();
  // 页面不可见：停止；恢复可见时立即刷新一次。
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  const hidden = seen.length;
  await page.clock.fastForward(40_000);
  await page.waitForTimeout(100);
  expect(seen.length).toBe(hidden);
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect.poll(() => seen.length).toBeGreaterThan(hidden);
});

test('节点页：状态、不可达、只读（AC-OPS-05-1、05-2）', async ({ page }) => {
  const problems = watchPage(page);
  const v = await provision('view', 'ops_viewer');
  await login(page, v);
  await probe();
  await page.goto('/nodes');
  const row = (id: string) => page.getByRole('row').filter({ has: page.getByRole('cell', { name: id, exact: true }) });
  await expect(row('n1')).toContainText('就绪');
  await expect(row('n2')).toContainText('就绪');
  await expect(page.getByRole('columnheader', { name: '存活内存估算' })).toBeVisible();
  await expect(page.getByRole('columnheader', { name: '堆 + 栈' })).toBeVisible();
  // 没有任何操作按钮。
  await expect(page.locator('table').getByRole('button')).toHaveCount(0);
  // 暂停 n2：20 秒后不可达，节点还在列表里。
  await pauseNode('n2');
  try {
    for (let i = 0; i < 4; i++) await probe();
    await page.getByRole('button', { name: '刷新', exact: true }).click();
    await expect(row('n2')).toContainText('不可达');
    await expect(page.getByText('节点 n2 未响应，结果可能不完整')).toBeVisible();
  } finally {
    await resumeNode('n2');
  }
  await probe();
  expect(problems).toEqual([]);
});

test('连接排查：结果、不进 URL、断开记录（AC-OPS-08-1、08-2、09-1、09-3）', async ({ page }) => {
  const problems = watchPage(page);
  const e = await provision('eng', 'ops_engineer');
  const u = uid('u');
  await probe();
  await login(page, e);
  await page.goto('/troubleshoot');
  // 不在线（包括不存在的用户）。
  await query(page, u);
  await expect(page.getByText('当前不在线')).toBeVisible();
  // 校验提示。
  await page.getByLabel('工单号').fill('CS 1024');
  await expect(page.getByText('工单号是 3～32 位')).toBeVisible();
  await expect(page.getByRole('button', { name: '查询', exact: true })).toBeDisabled();
  await page.getByLabel('工单号').fill(TICKET);
  await page.getByLabel('理由').fill('aaaa');
  await expect(page.getByRole('button', { name: '查询', exact: true })).toBeDisabled();

  const web = await dial('n1', u, 'web');
  const pc = await dial('n2', u, 'pc');
  await new Promise((r) => setTimeout(r, 100));
  const urls: string[] = [];
  page.on('request', (r) => urls.push(r.url()));
  await tick(1000);
  await query(page, u);
  const conn = page.getByRole('region').or(page.locator('section')).filter({ hasText: '当前连接' });
  await expect(conn.getByRole('cell', { name: 'web', exact: true })).toBeVisible();
  await expect(conn.getByRole('cell', { name: 'pc', exact: true })).toBeVisible();
  await expect(conn.getByRole('cell', { name: 'n1', exact: true })).toBeVisible();
  await expect(conn.getByRole('cell', { name: 'n2', exact: true })).toBeVisible();
  await expect(conn.getByRole('cell', { name: /\.\*\.\*$/ }).first()).toBeVisible();
  await expect(page.getByText('当前不在线')).toHaveCount(0);
  // 全程 URL 里没有 userId、工单、理由。
  for (const x of urls) {
    expect(x).not.toContain(u);
    expect(x).not.toContain(TICKET);
    expect(x).not.toContain(encodeURIComponent(REASON));
  }
  expect(page.url()).toMatch(/\/troubleshoot$/);
  const stored = await page.evaluate(
    () => JSON.stringify(localStorage) + JSON.stringify(sessionStorage) + JSON.stringify(history.state),
  );
  expect(stored).not.toContain(u);

  // 强制下线后：会话中 4012，含义来自协议。
  await forceLogout('n1', u);
  await forceLogout('n2', u);
  await new Promise((r) => setTimeout(r, 150));
  await tick(1000);
  await query(page, u);
  const row = page.getByRole('row').filter({ hasText: '4012' }).first();
  await expect(row).toContainText('会话中');
  await expect(row).toContainText('账号已被强制下线');
  await expect(row).toContainText('banned');
  await expect(row).toContainText('服务端');
  await expect(page.getByText('关闭码汇总')).toContainText('4012 × 2');
  await expect(page.getByText('多数断开由服务端发起')).toBeVisible();
  await expect(page.getByText('本页无法按用户归属的握手拒绝')).toBeVisible();
  await expect(page.getByText('4401 × 3')).toBeVisible();
  await expect(page.getByText(/数据范围：每个节点最近约 2 万条/)).toBeVisible();
  web.close();
  pc.close();
  expect(problems).toEqual([]);
});

test('节点没响应：不说不在线（AC-OPS-08-11）', async ({ page }) => {
  const e = await provision('eng', 'ops_engineer');
  await login(page, e);
  await page.goto('/troubleshoot');
  await pauseNode('n2');
  try {
    await query(page, uid('u'));
    await expect(page.getByText('在已响应的 1 个节点上未找到连接；节点 n2 未响应，结果可能不完整')).toBeVisible();
    await expect(page.getByText('当前不在线')).toHaveCount(0);
  } finally {
    await resumeNode('n2');
  }
});

test('超出每日上限的文案（AC-OPS-08-9）', async ({ page }) => {
  const e = await provision('eng', 'ops_engineer');
  const api = await loginApi(e);
  for (let i = 0; i < 50; i++) {
    if (i % 25 === 0) await tick(61_000);
    await api.call('POST', '/console/api/ops/v1/troubleshoot/query', {
      userId: `q${i}`,
      ticket: TICKET,
      reason: REASON,
    });
  }
  await tick(61_000);
  await login(page, e);
  await page.goto('/troubleshoot');
  await query(page, 'one-more');
  await expect(page.getByRole('alert')).toHaveText('今日排查用户数已达上限，请联系运维超管');
});

test('配置检查：风险、差异、不显示密钥（AC-OPS-10-2、10-4、10-5、10-6）', async ({ page }) => {
  const problems = watchPage(page);
  const v = await provision('view', 'ops_viewer');
  await login(page, v);
  await page.goto('/config');
  await expect(page.getByRole('heading', { name: '节点 n1' })).toBeVisible();
  await expect(page.getByRole('heading', { name: '节点 n2' })).toBeVisible();
  // stack.mjs 给两个节点配了 IM_ALLOWED_ORIGINS=*。
  await expect(page.getByText(/高风险：.*Origin 白名单含 \*/).first()).toBeVisible();
  await expect(page.getByText('不适用（非生产环境）').first()).toBeVisible();
  // 只读。
  await expect(page.locator('main').getByRole('button', { name: /修改|保存/ })).toHaveCount(0);
  await expect(page.locator('body')).not.toContainText('tianting-e2e-legacy-key');
  expect(problems).toEqual([]);
});

test('数据库与备份：迁移、备份、只显示文件名（AC-OPS-11-1、12-1、12-3）', async ({ page }) => {
  const problems = watchPage(page);
  await control('/manifests/clear');
  await control('/fake', { s3Down: false });
  const v = await provision('view', 'ops_viewer');
  const now = clockNow();
  await control('/manifest', {
    source: 'im',
    result: 'success',
    trigger: 'pre-migrate',
    release: 'v1.2.3',
    finishedAt: now - 60_000,
    file: '/srv/secret/a.db.age',
    size: 2097152,
    verified: true,
    encrypted: true,
    uploaded: true,
  });
  await control('/manifest', {
    source: 'im',
    result: 'failed',
    trigger: 'schedule',
    finishedAt: now - 30_000,
    file: 'b.db',
    error: '加密失败',
  });
  await control('/manifest', {
    source: 'console',
    result: 'success',
    trigger: 'schedule',
    finishedAt: now - 3 * 3600_000,
    file: 'c.dump.age',
  });
  await tick(31_000);
  await login(page, v);
  await page.goto('/database');
  await expect(page.getByRole('heading', { name: '节点 n1' })).toBeVisible();
  await expect(page.getByText('一致').first()).toBeVisible();
  await expect(page.getByText('sqlite').first()).toBeVisible();
  // 备份。
  await expect(page.getByRole('cell', { name: 'a.db.age' })).toBeVisible();
  await expect(page.locator('body')).not.toContainText('/srv/secret');
  await expect(page.getByRole('cell', { name: /发布前.*v1\.2\.3/ })).toBeVisible();
  await expect(page.getByRole('cell', { name: /失败.*加密失败/ })).toBeVisible();
  const consoleSection = page.locator('section').filter({ hasText: 'console-server' });
  await expect(consoleSection.getByText(/超过 2 小时/)).toBeVisible();
  const imSection = page.locator('section').filter({ hasText: 'im-server' });
  await expect(imSection.getByText(/超过 2 小时/)).toHaveCount(0);
  // 没有备份、恢复、下载、迁移的入口。
  await expect(page.locator('main').getByRole('button', { name: /备份|恢复|下载|迁移/ })).toHaveCount(0);
  expect(problems).toEqual([]);
});

test('指标：票据跳转，身份只来自代理，退出后失效（AC-OPS-17-1、17-3、17-4）', async ({ page, context }) => {
  const v = await provision('view', 'ops_viewer');
  await login(page, v);
  await page.getByRole('navigation', { name: '主菜单' }).getByRole('button', { name: '指标' }).click();
  await expect(page.locator('#who')).toHaveText(`Grafana:${v.username}`);
  expect(new URL(page.url()).hostname).toBe('grafana.ops.localhost');
  // 地址栏没有留下票据。
  expect(page.url()).not.toContain('ticket');
  const cookies = await context.cookies('http://grafana.ops.localhost:18290');
  const ck = cookies.find((c) => c.name === '__Host-grafana_sid');
  expect(ck?.httpOnly).toBe(true);
  // 运维后台退出后刷新 Grafana：跳回登录页。
  await page.goto('/');
  await page.getByRole('button', { name: '退出' }).click();
  await expect(page).toHaveURL(/\/login$/);
  await page.goto('http://grafana.ops.localhost:18290/d/x');
  await expect(page).toHaveURL(/ops\.localhost:18290\/login$/);
});

test('账号管理：互斥角色（AC-OPS-02-9）；审计：来源和中文动作（AC-OPS-15-1）', async ({ page, browser }) => {
  const problems = watchPage(page);
  const e = await provision('eng', 'ops_engineer');
  const aud = await provision('aud', 'ops_auditor');
  await provision('eng', 'ops_engineer'); // 审计员之后新建的，才会通知他
  const u = uid('u');
  const engCtx = await browser.newContext({ baseURL: 'http://ops.localhost:18290' });
  const engPage = await engCtx.newPage();
  await login(engPage, e);
  await engPage.goto('/troubleshoot');
  await query(engPage, u);
  await expect(engPage.getByText('当前不在线')).toBeVisible();
  await engCtx.close();

  await login(page, aud);
  await page.goto('/audit');
  await page.getByLabel('目标').fill(`user:${u}`);
  await page.getByRole('button', { name: '查询', exact: true }).click();
  const rows = page.getByRole('row').filter({ hasText: '连接排查' });
  await expect(rows.first()).toBeVisible();
  await expect(rows.first()).toContainText(e.username);
  await expect(rows.first()).toContainText('运维');
  await rows.first().getByRole('button', { name: '详情' }).click();
  const d = page.getByRole('dialog', { name: '审计详情' });
  await expect(d).toContainText(REASON);
  await expect(d).toContainText(TICKET);
  await expect(d).toContainText('"partial":false');
  await d.getByRole('button', { name: '关闭' }).click();
  // 通知：审计员看到新建排障账号。
  await page.goto('/notifications');
  await expect(page.getByText('新建了排障账号或授予了敏感角色').first()).toBeVisible();
  await page.getByRole('button', { name: '退出' }).click();

  await login(page, rootAccount());
  await page.goto('/accounts');
  await page.getByRole('button', { name: '新建账号' }).click();
  const dlg = page.getByRole('dialog', { name: '新建账号' });
  await dlg.getByLabel('运维超管').check();
  await expect(dlg.getByLabel('只读')).toBeDisabled();
  await expect(dlg.getByLabel('审计员')).toBeDisabled();
  await dlg.getByLabel('运维超管').uncheck();
  await dlg.getByLabel('排障工程师').check();
  await expect(dlg.getByLabel('只读')).toBeEnabled();
  await expect(dlg.getByLabel('审计员')).toBeDisabled();
  await expect(dlg.getByLabel('运维超管')).toBeDisabled();
  expect(problems).toEqual([]);
});

test('不能被 iframe 嵌入（X-Frame-Options、CSP）', async ({ page }) => {
  await page.goto('about:blank');
  await page.setContent(`<iframe src="http://ops.localhost:18290/login"></iframe>`);
  await page.waitForTimeout(500);
  const frame = page.frames().find((f) => f.url().includes('/login'));
  const loaded = frame
    ? await frame
        .locator('#root')
        .count()
        .catch(() => 0)
    : 0;
  expect(loaded).toBe(0);
});

test('响应头是运维的严格 CSP（AC-OPS-03-4）', async ({ request }) => {
  const r = await request.get('/login');
  const h = r.headers();
  expect(h['content-security-policy']).toContain("style-src 'self'");
  expect(h['content-security-policy']).not.toContain('nonce');
  expect(h['content-security-policy']).toContain("img-src 'self'");
  expect(h['content-security-policy']).not.toContain('data:');
  expect(h['x-frame-options']).toBe('DENY');
  expect(h['x-content-type-options']).toBe('nosniff');
  expect(h['referrer-policy']).toBe('no-referrer');
});
