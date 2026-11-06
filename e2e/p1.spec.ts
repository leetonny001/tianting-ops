import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import {
  activate,
  Api,
  clockNow,
  control,
  freshOtp,
  login,
  loginApi,
  provision,
  REASON,
  rootAccount,
  secondRoot,
  setClocks,
  TICKET,
  uid,
  watchPage,
  type Account,
} from './helpers';

// 第二批 / P1（FE-520、FE-521）。连真实的 console-server；Alertmanager 是符合 v2 API 的假服务，见 stack.mjs。

interface AmRequest {
  method: string;
  path: string;
  body: {
    matchers: { name: string; value: string; isRegex: boolean; isEqual: boolean }[];
    createdBy: string;
    comment: string;
    startsAt: string;
    endsAt: string;
  } | null;
}
const amRequests = async () => (await control('/am-requests')) as AmRequest[];

/** 4038 之后弹的 TOTP 框：输入当前动态码，通过后原请求自动重放。 */
async function passStepUp(page: Page, a: Account) {
  const dlg = page.getByRole('dialog', { name: '输入动态码确认' });
  await expect(dlg).toBeVisible();
  await dlg.getByLabel('动态码').fill(await freshOtp(a.seed));
  await dlg.getByRole('button', { name: '验证' }).click();
  await expect(dlg).toHaveCount(0);
}

const SILENCE_MATCH = 'alertname=节点不可达，node_id=n1';

test('告警静默：4038 走 TOTP 后重放，内容正确；总览显示；提前结束（AC-OPS-18-1、18-3）', async ({ page, browser }) => {
  const problems = watchPage(page);
  const e = await provision('eng', 'ops_engineer');
  const v = await provision('view', 'ops_viewer');
  await login(page, e);
  await page.getByRole('navigation', { name: '主菜单' }).getByRole('link', { name: '告警静默' }).click();
  await expect(page.getByRole('heading', { name: '告警静默' })).toBeVisible();
  await expect(page.getByText('当前没有生效的静默').or(page.getByRole('row').first())).toBeVisible();

  const before = (await amRequests()).filter((r) => r.method !== 'GET').length;
  const form = page.getByRole('form', { name: '创建静默' });
  await page.getByLabel('告警名（alertname）').fill('节点不可达');
  await page.getByLabel('节点（node_id）').fill('n1');
  await form.getByLabel('工单号').fill(TICKET);
  await form.getByLabel('理由').fill(REASON);
  await page.getByRole('button', { name: '创建静默' }).click();
  await passStepUp(page, e);

  const row = page.getByRole('row').filter({ hasText: SILENCE_MATCH }).filter({ hasText: e.username });
  await expect(row).toBeVisible();
  const writes = (await amRequests()).filter((r) => r.method !== 'GET').slice(before);
  expect(writes).toHaveLength(1); // 4038 那次没有到 Alertmanager
  const body = writes[0]!.body!;
  expect(writes[0]!.method).toBe('POST');
  expect(body.createdBy).toBe(e.username);
  expect(body.comment).toBe(TICKET);
  expect(body.matchers).toEqual([
    { name: 'alertname', value: '节点不可达', isRegex: false, isEqual: true },
    { name: 'node_id', value: 'n1', isRegex: false, isEqual: true },
  ]);
  expect(Date.parse(body.endsAt) - Date.parse(body.startsAt)).toBe(3600_000);
  // 工单号和理由不进 URL。
  expect(page.url()).not.toContain(TICKET);

  // 只读账号在总览的告警卡片看到匹配条件、创建人和到期时间，没有告警也显示（AC-OPS-18-3 的页面部分）。
  const viewCtx = await browser.newContext({ baseURL: 'http://ops.localhost:18290' });
  const viewPage = await viewCtx.newPage();
  await login(viewPage, v);
  const card = viewPage.getByRole('region', { name: '告警' });
  await expect(card).toContainText('当前没有告警');
  await expect(card).toContainText(SILENCE_MATCH);
  await expect(card).toContainText(`${e.username} 创建`);
  await expect(card).toContainText('到期');
  await expect(card).not.toContainText(TICKET);
  // 只读账号没有静默页。
  await expect(
    viewPage.getByRole('navigation', { name: '主菜单' }).getByRole('link', { name: '告警静默' }),
  ).toHaveCount(0);
  await viewPage.goto('/silences');
  await expect(viewPage.getByRole('heading', { name: '无权限' })).toBeVisible();
  await viewCtx.close();

  // 提前结束：过了 5 分钟要重新验证（工程师一直在操作，会话不过期）。
  await page.reload();
  await setClocks(clockNow() + 301_000);
  await row.getByRole('button', { name: '提前结束' }).click();
  const dlg = page.getByRole('dialog', { name: '提前结束静默' });
  await expect(dlg.getByRole('button', { name: '提前结束' })).toBeDisabled();
  await dlg.getByLabel('工单号').fill('CS-2048');
  await dlg.getByLabel('理由').fill('节点已恢复');
  await dlg.getByRole('button', { name: '提前结束' }).click();
  await passStepUp(page, e);
  await expect(dlg).toHaveCount(0);
  await expect(row).toHaveCount(0);
  const all = await amRequests();
  const del = all.filter((r) => r.method === 'DELETE');
  expect(del).toHaveLength(1);
  expect(del[0]!.path).toMatch(/^\/api\/v2\/silence\/[0-9a-f-]{36}$/);
  expect(problems).toEqual([]);
});

test('告警静默：Alertmanager 不可用时写操作失败、页面说读不到（AC-OPS-18-2 的页面部分）', async ({ page }) => {
  const e = await provision('eng', 'ops_engineer');
  await login(page, e);
  await page.goto('/silences');
  // 前端先挡：非法输入点不了，也不会发请求。
  const before = (await amRequests()).filter((r) => r.method !== 'GET').length;
  const form = page.getByRole('form', { name: '创建静默' });
  await page.getByLabel('告警名（alertname）').fill('.*');
  await form.getByLabel('工单号').fill(TICKET);
  await form.getByLabel('理由').fill(REASON);
  await expect(page.getByRole('button', { name: '创建静默' })).toBeDisabled();
  await page.getByLabel('告警名（alertname）').fill('节点不可达');
  await page.getByLabel('时长（分钟）').fill('1500');
  await expect(page.getByRole('button', { name: '创建静默' })).toBeDisabled();
  await page.getByLabel('时长（分钟）').fill('60');
  expect((await amRequests()).filter((r) => r.method !== 'GET').length).toBe(before);

  await control('/fake', { amDown: true });
  try {
    await page.getByRole('button', { name: '创建静默' }).click();
    await passStepUp(page, e);
    await expect(form.getByRole('alert')).toContainText('服务暂时不可用');
    await page.reload();
    await expect(page.getByText('告警数据不可用')).toBeVisible();
    await expect(page.getByText('当前没有生效的静默')).toHaveCount(0);
  } finally {
    await control('/fake', { amDown: false });
  }
});

test('双人批准：本人批准以服务端 4030 为准；另一名超管 TOTP 后重放；批准后才能排查（AC-OPS-02-8）', async ({
  page,
  browser,
}) => {
  const problems = watchPage(page);
  const rootB = await secondRoot();
  const a = rootAccount();
  await login(page, a);
  await page.goto('/accounts');
  const name = uid('xeng');
  await page.getByRole('button', { name: '新建账号' }).click();
  const create = page.getByRole('dialog', { name: '新建账号' });
  await create.getByLabel('账号名').fill(name);
  await create.getByLabel('显示名').fill(name);
  await create.getByLabel('排障工程师').check();
  await expect(create).toContainText('需要另一名运维超管批准后才生效');
  await create.getByRole('button', { name: '创建' }).click();
  await passStepUp(page, a);
  const codeDlg = page.getByRole('dialog', { name: '激活码' });
  await expect(codeDlg).toContainText('排障工程师角色待批准');
  const code = await codeDlg.getByTestId('activation-code').innerText();
  await codeDlg.getByRole('button', { name: '我已记下' }).click();

  const row = page.getByRole('row').filter({ hasText: name });
  await expect(row).toContainText('待批准');
  await expect(row).toContainText(`${a.username} 发起`);

  // 账号激活后还没有权限。
  const { api: x, account } = await activate(name, code);
  const queryAs = (api: Api) =>
    api
      .call('POST', '/console/api/ops/v1/troubleshoot/query', { userId: 'u1', ticket: TICKET, reason: REASON })
      .then(() => 'ok')
      .catch((e: Error) => e.message);
  expect(await queryAs(x)).toContain('403');

  // A 自己批准：按钮能点，服务端 4030，错误显示在框内，状态不变。
  await row.getByRole('button', { name: '批准' }).click();
  const approve = page.getByRole('dialog', { name: `批准 ${name} 的角色` });
  await approve.getByRole('button', { name: '批准' }).click();
  await expect(approve.getByRole('alert')).toContainText('不能批准自己发起的授予');
  await approve.getByRole('button', { name: '取消' }).click();
  await page.reload();
  await expect(row).toContainText('待批准');
  expect(await queryAs(x)).toContain('403');

  // B 批准：没有重新验证过，走 TOTP 框，通过后重放。
  const bCtx = await browser.newContext({ baseURL: 'http://ops.localhost:18290' });
  const bPage = await bCtx.newPage();
  await login(bPage, rootB);
  await bPage.goto('/accounts');
  const bRow = bPage.getByRole('row').filter({ hasText: name });
  await expect(bRow).not.toContainText('需要另一名运维超管批准');
  await bRow.getByRole('button', { name: '批准' }).click();
  const bApprove = bPage.getByRole('dialog', { name: `批准 ${name} 的角色` });
  await bApprove.getByRole('button', { name: '批准' }).click();
  await passStepUp(bPage, rootB);
  await expect(bApprove).toHaveCount(0);
  await expect(bRow).not.toContainText('待批准');
  await expect(bRow).toContainText('排障工程师');
  await expect(bRow.getByRole('button', { name: '批准' })).toHaveCount(0);
  await bCtx.close();

  // 旧会话失效，重新登录后可以排查。
  expect(await queryAs(x)).toContain('401');
  const fresh = await loginApi(account);
  expect(await queryAs(fresh)).toBe('ok');
  expect(problems).toEqual([]);
});

test('审计导出：4038 走 TOTP 后重放，下载 CSV，写审计（AC-OPS-15-8）', async ({ page }) => {
  const problems = watchPage(page);
  const aud = await provision('aud', 'ops_auditor');
  await login(page, aud);
  await page.goto('/audit');
  await page.getByLabel('动作').selectOption('account.create');
  const downloaded = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出 CSV' }).click();
  await passStepUp(page, aud);
  const file = await downloaded;
  expect(file.suggestedFilename()).toMatch(/^audit-ops-\d{8}-\d{6}\.csv$/);
  const text = readFileSync(await file.path(), 'utf8');
  expect(text.startsWith('﻿seq,time,space,')).toBe(true);
  const lines = text.trim().split('\n');
  expect(lines.length).toBeGreaterThan(1);
  for (const l of lines.slice(1)) expect(l).toContain('account.create');
  expect(page.url()).not.toContain('account.create');
  await expect(page.getByText(file.suggestedFilename())).toBeVisible();

  // 审计页能看到这次导出，动作显示中文，含条数。
  await page.getByLabel('动作').selectOption('ops.audit.export');
  await page.getByRole('button', { name: '查询', exact: true }).click();
  const row = page.getByRole('row').filter({ hasText: '导出审计' }).first();
  await expect(row).toContainText(aud.username);
  await row.getByRole('button', { name: '详情' }).click();
  const d = page.getByRole('dialog', { name: '审计详情' });
  await expect(d).toContainText(`"count":${lines.length - 1}`);
  await expect(d).toContainText('"action":"account.create"');
  await d.getByRole('button', { name: '关闭' }).click();

  // 5 分钟内不再询问。
  const again = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出 CSV' }).click();
  await again;
  await expect(page.getByRole('dialog', { name: '输入动态码确认' })).toHaveCount(0);
  expect(problems).toEqual([]);
});

test('异常查询通知：审计员看到账号名和数量，没有 userId（AC-OPS-08-14）', async ({ page }) => {
  const aud = await provision('aud', 'ops_auditor');
  const e = await provision('eng', 'ops_engineer');
  const api = await loginApi(e);
  const ids: string[] = [];
  for (let i = 0; i < 20; i++) {
    const id = uid('canary');
    ids.push(id);
    await api.call('POST', '/console/api/ops/v1/troubleshoot/query', { userId: id, ticket: TICKET, reason: REASON });
  }
  await login(page, aud);
  await page.goto('/notifications');
  const item = page.getByRole('listitem').filter({ hasText: '异常查询' });
  await expect(item).toHaveCount(1);
  await expect(item).toContainText(e.username);
  await expect(item).toContainText('20 个不同用户');
  const body = await page.locator('body').innerText();
  for (const id of ids) expect(body).not.toContain(id);
});

const accountsApi = '/console/api/accounts';

/** A 用接口授予 X 排障工程师（X 现有角色不变），返回 X 的 id。 */
async function grantEngineer(a: Account, name: string, roles = ['ops_viewer']) {
  const api = await loginApi(a);
  await api.call('POST', '/console/api/auth/step-up', { otp: await freshOtp(a.seed) });
  const created = await api.call<{ id: string }>('POST', accountsApi, { username: name, displayName: name, roles });
  await api.call('POST', `${accountsApi}/${created.id}/roles`, { roles: [...roles, 'ops_engineer'] });
  return created.id;
}

test('新建超管也要批准；拒绝要理由和重新验证；发起人可以撤回（AC-OPS-02-10、02-11）', async ({ page, browser }) => {
  const problems = watchPage(page);
  const a = rootAccount();
  const rootB = await secondRoot();
  await login(page, a);
  await page.goto('/accounts');

  // A 新建超管 Y：待批准，显示发起人、到期时间。
  const name = uid('ysup');
  await page.getByRole('button', { name: '新建账号' }).click();
  const create = page.getByRole('dialog', { name: '新建账号' });
  await create.getByLabel('账号名').fill(name);
  await create.getByLabel('显示名').fill(name);
  await create.getByLabel('运维超管').check();
  await expect(create).toContainText('授予运维超管需要另一名运维超管批准后才生效');
  await create.getByRole('button', { name: '创建' }).click();
  await passStepUp(page, a);
  const codeDlg = page.getByRole('dialog', { name: '激活码' });
  await expect(codeDlg).toContainText('运维超管角色待批准');
  const code = await codeDlg.getByTestId('activation-code').innerText();
  await codeDlg.getByRole('button', { name: '我已记下' }).click();
  const row = page.getByRole('row').filter({ hasText: name });
  await expect(row).toContainText('待批准');
  await expect(row).toContainText(`${a.username} 发起`);
  await expect(row).toContainText('到期');

  // Y 激活后只有"只需登录"的权限。
  const { api: y, account: yAccount } = await activate(name, code);
  const manage = (api: Api) =>
    api
      .call('GET', accountsApi)
      .then(() => 'ok')
      .catch((e: Error) => e.message);
  expect(await manage(y)).toContain('403');

  // B 拒绝：没有理由不能提交；理由之后走重新验证；拒绝后 Y 还是没有权限。
  const bCtx = await browser.newContext({ baseURL: 'http://ops.localhost:18290' });
  const bPage = await bCtx.newPage();
  await login(bPage, rootB);
  await bPage.goto('/accounts');
  const bRow = bPage.getByRole('row').filter({ hasText: name });
  await bRow.getByRole('button', { name: '拒绝' }).click();
  const reject = bPage.getByRole('dialog', { name: `拒绝 ${name} 的角色` });
  await expect(reject.getByRole('button', { name: '拒绝' })).toBeDisabled();
  await reject.getByLabel('理由').fill(REASON);
  await reject.getByRole('button', { name: '拒绝' }).click();
  await passStepUp(bPage, rootB);
  await expect(reject).toHaveCount(0);
  await expect(bRow).not.toContainText('待批准');
  expect(await manage(y)).toContain('403');

  // A 的页面还是旧的：再点批准，提示已失效并刷新。
  await row.getByRole('button', { name: '批准' }).click();
  const staleDlg = page.getByRole('dialog', { name: `批准 ${name} 的角色` });
  await staleDlg.getByRole('button', { name: '批准' }).click();
  await expect(staleDlg).toHaveCount(0);
  await expect(page.getByRole('status')).toContainText('这条待批准已经失效');
  await expect(row).not.toContainText('待批准');

  // A 再发起一次，自己撤回。
  const apiA = await loginApi(a);
  await apiA.call('POST', '/console/api/auth/step-up', { otp: await freshOtp(a.seed) });
  const id = (
    await apiA.call<{ accounts: { id: string; username: string }[] }>('GET', `${accountsApi}?username=${name}`)
  ).accounts[0]!.id;
  await apiA.call('POST', `${accountsApi}/${id}/roles`, { roles: ['ops_superadmin'] });
  await page.reload();
  await expect(row).toContainText('待批准');
  await row.getByRole('button', { name: '撤回' }).click();
  const withdraw = page.getByRole('dialog', { name: `拒绝 ${name} 的角色` });
  await withdraw.getByLabel('理由').fill(REASON);
  await withdraw.getByRole('button', { name: '拒绝' }).click();
  await expect(withdraw).toHaveCount(0);
  await expect(row).not.toContainText('待批准');

  // 再发起一次，B 批准：Y 重新登录后能管理账号。
  await apiA.call('POST', '/console/api/auth/step-up', { otp: await freshOtp(a.seed) });
  await apiA.call('POST', `${accountsApi}/${id}/roles`, { roles: ['ops_superadmin'] });
  await bPage.reload();
  await bRow.getByRole('button', { name: '批准' }).click();
  const approve = bPage.getByRole('dialog', { name: `批准 ${name} 的角色` });
  await approve.getByRole('button', { name: '批准' }).click();
  await passStepUpIfAsked(bPage, rootB, approve);
  await expect(approve).toHaveCount(0);
  await expect(bRow).toContainText('运维超管');
  await expect(bRow).not.toContainText('待批准');
  await bCtx.close();
  expect(await manage(y)).toContain('401');
  expect(await manage(await loginApi(yAccount))).toBe('ok');
  expect(problems.filter((p) => !/40[39]|401/.test(p))).toEqual([]);
});

/** step-up 还在 5 分钟内就不会弹框：弹了才走。 */
async function passStepUpIfAsked(page: Page, a: Account, dialog: ReturnType<Page['getByRole']>) {
  const totp = page.getByRole('dialog', { name: '输入动态码确认' });
  await expect(totp.or(dialog)).toBeVisible();
  if (await totp.isVisible().catch(() => false)) await passStepUp(page, a);
}

test('待批准 7 天过期：快到期还在列表，过期后批准提示已失效（AC-OPS-02-12）', async ({ page }) => {
  const problems = watchPage(page);
  const a = rootAccount();
  const rootB = await secondRoot();
  const name = uid('xexp');
  const start = clockNow();
  const id = await grantEngineer(a, name);
  const expiresAt = (
    await (
      await loginApi(a)
    ).call<{ pendingRoles: { expiresAt: number; requestedAt: number }[] }>('GET', `${accountsApi}/${id}`)
  ).pendingRoles[0]!;
  expect(expiresAt.expiresAt - expiresAt.requestedAt).toBe(7 * 86_400_000);
  expect(expiresAt.requestedAt).toBeGreaterThanOrEqual(start);

  await setClocks(expiresAt.expiresAt - 5 * 60_000);
  await login(page, rootB);
  await page.goto('/accounts');
  const row = page.getByRole('row').filter({ hasText: name });
  await expect(row).toContainText('待批准');

  await setClocks(expiresAt.expiresAt + 1000);
  await row.getByRole('button', { name: '批准' }).click();
  const dlg = page.getByRole('dialog', { name: `批准 ${name} 的角色` });
  await dlg.getByRole('button', { name: '批准' }).click();
  await passStepUp(page, rootB);
  await expect(dlg).toHaveCount(0);
  await expect(page.getByRole('status')).toContainText('这条待批准已经失效');
  await expect(row).not.toContainText('待批准');
  await expect(row).toContainText('只读');
  await page.reload();
  await expect(row).not.toContainText('待批准');
  // 过期审计：审计页面能看到，只有一条。
  const auditor = await provision('xaud', 'ops_auditor');
  await page.context().clearCookies();
  await login(page, auditor);
  await page.goto('/audit');
  const audit = await (
    await loginApi(auditor)
  ).call<{ records: { action: string; target: string }[] }>(
    'GET',
    `/console/api/audit?from=${expiresAt.requestedAt}&to=${clockNow()}&action=ops.role.expire`,
  );
  expect(
    audit.records.filter((r) => r.action === 'ops.role.expire' && JSON.stringify(r.target).includes(name)),
  ).toHaveLength(1);
  expect(problems.filter((p) => !/409/.test(p))).toEqual([]);
});
