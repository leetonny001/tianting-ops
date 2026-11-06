import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetClient } from '../api/client';
import { SessionProvider } from '../session';
import { AccountsPage } from './Accounts';
import { AuditPage } from './Audit';
import { OverviewPage } from './Overview';
import { SilencesPage } from './Silences';

// 第二批 / P1 的页面（FE-520、FE-521）：用真实的 SessionProvider 和 API 客户端，只换 fetch，所以 4038 → 弹框 → 重放是真的走了一遍。

type Reply = { status?: number; body: unknown; headers?: Record<string, string>; raw?: BodyInit };
let replies: Record<string, Reply[]>;
let calls: { method: string; path: string; body: Record<string, unknown> | undefined }[];

const me = (username: string, perms: string[]) => ({
  account: { id: 'me', username, displayName: username, space: 'ops' },
  roles: [],
  perms,
  state: 'full',
  csrfToken: 't',
});

function install(session: unknown) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (path: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
      calls.push({ method, path, body });
      if (path === '/console/api/session') return new Response(JSON.stringify(session));
      const q = replies[`${method} ${path}`];
      const r = q?.length && q.length > 1 ? q.shift()! : q?.[0];
      if (!r) return new Response(JSON.stringify({ code: 4040 }), { status: 404 });
      return new Response(r.raw ?? JSON.stringify(r.body), { status: r.status ?? 200, headers: r.headers });
    }),
  );
}

const env = (data: unknown) => ({ data, partial: false, missingNodes: [], dataTime: 1 });
const stepUpRequired: Reply = { status: 403, body: { code: 4038, msg: 'verify' } };
const posts = (path: string) => calls.filter((c) => c.method === 'POST' && c.path === path);

function page(node: ReactNode) {
  return render(
    <MemoryRouter>
      <SessionProvider>{node}</SessionProvider>
    </MemoryRouter>,
  );
}

async function passStepUp(user: ReturnType<typeof userEvent.setup>) {
  const dlg = await screen.findByRole('dialog', { name: '输入动态码确认', hidden: true });
  await user.type(within(dlg).getByLabelText('动态码'), '123456');
  await user.click(within(dlg).getByRole('button', { name: '验证', hidden: true }));
}

const silence = {
  id: '00000000-0000-4000-8000-000000000001',
  matchers: [
    { name: 'alertname', value: '节点不可达', isRegex: false, isEqual: true },
    { name: 'node_id', value: 'n1', isRegex: false, isEqual: true },
  ],
  createdBy: 'eng1',
  startsAt: '2027-01-15T00:00:00Z',
  endsAt: '2027-01-15T01:00:00Z',
};

beforeEach(() => {
  calls = [];
  replies = { 'POST /console/api/auth/step-up': [{ body: {} }] };
  resetClient();
  // jsdom 没有实现 <dialog>。
  HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
    this.open = true;
  };
  HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
    this.open = false;
  };
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('告警静默（FE-520）', () => {
  const eng = me('eng1', ['ops.silence.write', 'ops.overview.read']);
  beforeEach(() => {
    replies['GET /console/api/ops/v1/alerts'] = [{ body: env({ list: [], silences: [silence] }) }];
    replies['GET /console/api/ops/v1/nodes'] = [{ body: env({ nodes: [{ nodeId: 'n1' }] }) }];
  });

  const fill = async (user: ReturnType<typeof userEvent.setup>, name: string, node = '') => {
    if (name) await user.type(screen.getByLabelText('告警名（alertname）'), name);
    if (node) await user.type(screen.getByLabelText('节点（node_id）'), node);
    await user.type(screen.getByLabelText('工单号'), 'CS-1024');
    await user.type(screen.getByLabelText('理由'), '计划内重启节点');
  };

  it('4038：弹 TOTP 框，通过后重放创建，请求体只有两个等值条件（AC-OPS-18-1）', async () => {
    install(eng);
    replies['POST /console/api/ops/v1/silences'] = [stepUpRequired, { body: env({ id: 'x' }) }];
    const user = userEvent.setup();
    page(<SilencesPage />);
    await fill(user, '节点不可达', 'n1');
    await user.click(screen.getByRole('button', { name: '创建静默' }));
    await passStepUp(user);
    await waitFor(() => expect(posts('/console/api/ops/v1/silences')).toHaveLength(2));
    const [first, second] = posts('/console/api/ops/v1/silences');
    expect(second!.body).toEqual(first!.body);
    expect(second!.body).toEqual({
      matchers: [
        { name: 'alertname', value: '节点不可达' },
        { name: 'node_id', value: 'n1' },
      ],
      durationMinutes: 60,
      ticket: 'CS-1024',
      reason: '计划内重启节点',
    });
    expect(posts('/console/api/auth/step-up')[0]!.body).toEqual({ otp: '123456' });
    // 工单号和理由不进 URL。
    expect(calls.some((c) => c.path.includes('CS-1024') || c.path.includes('reason'))).toBe(false);
  });

  it('前端先挡：时长、正则、空条件都点不了（AC-OPS-18-2 的页面部分）', async () => {
    install(eng);
    const user = userEvent.setup();
    page(<SilencesPage />);
    const submit = await screen.findByRole('button', { name: '创建静默' });
    await user.type(screen.getByLabelText('工单号'), 'CS-1024');
    await user.type(screen.getByLabelText('理由'), '计划内重启节点');
    expect(submit).toBeDisabled(); // 两个条件都空
    await user.type(screen.getByLabelText('告警名（alertname）'), '.*');
    expect(submit).toBeDisabled();
    expect(screen.getByText('只能有文字、数字、_、-、.')).toBeVisible();
    await user.clear(screen.getByLabelText('告警名（alertname）'));
    await user.type(screen.getByLabelText('告警名（alertname）'), '节点不可达');
    expect(submit).toBeEnabled();
    const minutes = screen.getByLabelText('时长（分钟）');
    for (const bad of ['14', '1441', '1500']) {
      await user.clear(minutes);
      await user.type(minutes, bad);
      expect(submit).toBeDisabled();
    }
    await user.clear(minutes);
    await user.type(minutes, '1440');
    expect(submit).toBeEnabled();
    // 界面上没有别的标签或正则的入口。
    expect(screen.queryByLabelText(/正则/)).toBeNull();
    expect(screen.queryByLabelText(/severity/)).toBeNull();
  });

  it('服务端 4000 显示原因，表单不清空', async () => {
    install(eng);
    replies['POST /console/api/ops/v1/silences'] = [
      { status: 400, body: { code: 4000, reason: 'silenceDurationInvalid' } },
    ];
    const user = userEvent.setup();
    page(<SilencesPage />);
    await fill(user, '节点不可达');
    await user.click(screen.getByRole('button', { name: '创建静默' }));
    expect(await screen.findByText('时长需要在 15 分钟到 24 小时之间')).toBeVisible();
    expect(screen.getByLabelText('工单号')).toHaveValue('CS-1024');
  });

  it('列表和提前结束：要工单号和理由，4038 走 TOTP 后重放', async () => {
    install(eng);
    const path = `/console/api/ops/v1/silences/${silence.id}:expire`;
    replies[`POST ${path}`] = [stepUpRequired, { body: env({ id: silence.id }) }];
    const user = userEvent.setup();
    page(<SilencesPage />);
    const row = await screen.findByRole('row', { name: /alertname=节点不可达，node_id=n1/ });
    expect(row).toHaveTextContent('eng1');
    await user.click(within(row).getByRole('button', { name: '提前结束' }));
    const dlg = await screen.findByRole('dialog', { name: '提前结束静默', hidden: true });
    const go = within(dlg).getByRole('button', { name: '提前结束', hidden: true });
    expect(go).toBeDisabled();
    await user.type(within(dlg).getByLabelText('工单号'), 'CS-2048');
    await user.type(within(dlg).getByLabelText('理由'), '节点已恢复');
    await user.click(go);
    await passStepUp(user);
    await waitFor(() => expect(posts(path)).toHaveLength(2));
    expect(posts(path)[1]!.body).toEqual({ ticket: 'CS-2048', reason: '节点已恢复' });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '提前结束静默', hidden: true })).toBeNull());
  });

  it('取消 TOTP 框：不重放，不提示错误', async () => {
    install(eng);
    replies['POST /console/api/ops/v1/silences'] = [stepUpRequired];
    const user = userEvent.setup();
    page(<SilencesPage />);
    await fill(user, '节点不可达');
    await user.click(screen.getByRole('button', { name: '创建静默' }));
    const dlg = await screen.findByRole('dialog', { name: '输入动态码确认', hidden: true });
    await user.click(within(dlg).getByRole('button', { name: '取消', hidden: true }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '输入动态码确认', hidden: true })).toBeNull());
    expect(posts('/console/api/ops/v1/silences')).toHaveLength(1);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('静默读不到时说读不到，不说没有', async () => {
    install(eng);
    replies['GET /console/api/ops/v1/alerts'] = [
      { body: env({ list: [], silences: { unavailable: true, reason: 'Alertmanager 不可用' } }) },
    ];
    page(<SilencesPage />);
    expect(await screen.findByText('静默数据不可用')).toBeVisible();
    expect(screen.queryByText('当前没有生效的静默')).toBeNull();
  });
});

describe('总览的告警卡片（FE-520、AC-OPS-18-3）', () => {
  const overview = (alerts: unknown) => ({
    status: 'ok',
    versions: { list: ['1'], mismatch: false, over30Min: false },
    nodes: { ready: 1, total: 1 },
    connections: { total: 0, byPlatform: {} },
    messages: { unavailable: true, reason: 'x' },
    errors: { unavailable: true, reason: 'x' },
    disconnects: { unavailable: true, reason: 'x' },
    backup: { sources: [] },
    alerts,
  });
  const card = async () => screen.findByRole('region', { name: '告警' });

  it('显示匹配条件、创建人和到期时间；没有告警时也显示', async () => {
    install(me('view', ['ops.overview.read']));
    replies['GET /console/api/ops/v1/overview'] = [{ body: env(overview({ list: [], silences: [silence] })) }];
    page(<OverviewPage />);
    const c = await card();
    expect(c).toHaveTextContent('当前没有告警');
    expect(c).toHaveTextContent('生效中的静默（1）');
    expect(c).toHaveTextContent('alertname=节点不可达，node_id=n1');
    expect(c).toHaveTextContent('eng1 创建');
    expect(c).toHaveTextContent('2027/01/15 09:00:00');
  });

  it('静默不可用不当成没有；告警不可用仍然显示不可用', async () => {
    install(me('view', ['ops.overview.read']));
    replies['GET /console/api/ops/v1/overview'] = [
      { body: env(overview({ list: [], silences: { unavailable: true, reason: 'Alertmanager 不可用' } })) },
    ];
    page(<OverviewPage />);
    expect(await card()).toHaveTextContent('静默数据不可用');
    cleanup();
    replies['GET /console/api/ops/v1/overview'] = [
      { body: env(overview({ unavailable: true, reason: 'Alertmanager 不可用' })) },
    ];
    page(<OverviewPage />);
    const c = await card();
    expect(c).toHaveTextContent('告警数据不可用');
    expect(c).not.toHaveTextContent('当前没有告警');
  });
});

describe('双人批准（FE-521、AC-OPS-02-8）', () => {
  const pendingAccount = (requestedBy: string) => ({
    id: '00000000-0000-4000-8000-00000000000a',
    username: 'xeng',
    displayName: 'xeng',
    status: 'active',
    roles: ['ops_viewer'],
    createdAt: 1,
    activatedAt: 1,
    locked: false,
    pendingRoles: [{ role: 'ops_engineer', requestedBy, requestedAt: 1, expiresAt: 2 }],
  });
  const approvePath = `/console/api/accounts/${pendingAccount('a').id}/roles/approve`;
  const open = async (user: ReturnType<typeof userEvent.setup>) => {
    const row = await screen.findByRole('row', { name: /xeng/ });
    await user.click(within(row).getByRole('button', { name: '批准' }));
    const dlg = await screen.findByRole('dialog', { name: '批准 xeng 的角色', hidden: true });
    await user.click(within(dlg).getByRole('button', { name: '批准', hidden: true }));
    return dlg;
  };

  it('显示待批准；另一名超管批准时 4038 走 TOTP 后重放', async () => {
    install(me('rootb', ['ops.account.manage']));
    replies['GET /console/api/accounts?limit=100'] = [{ body: { accounts: [pendingAccount('roota')] } }];
    replies[`POST ${approvePath}`] = [stepUpRequired, { body: { role: 'ops_engineer' } }];
    const user = userEvent.setup();
    page(<AccountsPage />);
    const row = await screen.findByRole('row', { name: /xeng/ });
    expect(row).toHaveTextContent('待批准');
    expect(row).toHaveTextContent('排障工程师');
    expect(row).toHaveTextContent('roota 发起');
    expect(row).not.toHaveTextContent('需要另一名运维超管批准');
    await open(user);
    await passStepUp(user);
    await waitFor(() => expect(posts(approvePath)).toHaveLength(2));
    expect(posts(approvePath)[1]!.body).toEqual({ role: 'ops_engineer' });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '批准 xeng 的角色', hidden: true })).toBeNull());
  });

  it('本人批准以服务端 4030 为准：按钮可以点，错误显示在框内，状态不变', async () => {
    install(me('roota', ['ops.account.manage']));
    replies['GET /console/api/accounts?limit=100'] = [{ body: { accounts: [pendingAccount('roota')] } }];
    replies[`POST ${approvePath}`] = [{ status: 403, body: { code: 4030, reason: 'ownGrant' } }];
    const user = userEvent.setup();
    page(<AccountsPage />);
    const row = await screen.findByRole('row', { name: /xeng/ });
    expect(row).toHaveTextContent('需要另一名运维超管批准');
    expect(within(row).getByRole('button', { name: '批准' })).toBeEnabled();
    const dlg = await open(user);
    expect(await within(dlg).findByText('不能批准自己发起的授予，需要另一名运维超管批准')).toBeVisible();
    expect(posts(approvePath)).toHaveLength(1);
    expect(screen.getByRole('row', { name: /xeng/, hidden: true })).toHaveTextContent('待批准');
  });

  it('改角色时待批准的角色默认勾着：保存不会撤回；提示要批准', async () => {
    install(me('roota', ['ops.account.manage']));
    replies['GET /console/api/accounts?limit=100'] = [{ body: { accounts: [pendingAccount('roota')] } }];
    const user = userEvent.setup();
    page(<AccountsPage />);
    const row = await screen.findByRole('row', { name: /xeng/ });
    await user.click(within(row).getByRole('button', { name: '改角色' }));
    const dlg = await screen.findByRole('dialog', { name: '修改 xeng 的角色', hidden: true });
    expect(within(dlg).getByLabelText('排障工程师')).toBeChecked();
    expect(within(dlg).getByLabelText('只读')).toBeChecked();
    expect(dlg).toHaveTextContent('授予排障工程师需要另一名运维超管批准后才生效');
  });
});

describe('拒绝和过期（FE-522、AC-OPS-02-10～12）', () => {
  const EXPIRES = Date.UTC(2027, 0, 22, 4, 0, 0); // 上海时间 2027-01-22 12:00
  const pendingRow = (over: Record<string, unknown> = {}, pending: Record<string, unknown> = {}) => ({
    id: '00000000-0000-4000-8000-00000000000b',
    username: 'xnew',
    displayName: 'xnew',
    status: 'pending',
    roles: [],
    createdAt: 1,
    activatedAt: 0,
    locked: false,
    pendingRoles: [
      {
        role: 'ops_superadmin',
        requestedBy: 'roota',
        requestedAt: EXPIRES - 7 * 86_400_000,
        expiresAt: EXPIRES,
        replaces: [],
        with: [],
        ...pending,
      },
    ],
    ...over,
  });
  const LIST = 'GET /console/api/accounts?limit=100';
  const ROLES = `/console/api/accounts/${pendingRow().id}/roles`;
  const listCalls = () => calls.filter((c) => c.method === 'GET' && c.path === '/console/api/accounts?limit=100');
  const clean = pendingRow({ pendingRoles: [] });
  const mount = async (who = 'rootb') => {
    install(me(who, ['ops.account.manage']));
    const user = userEvent.setup();
    page(<AccountsPage />);
    const row = await screen.findByRole('row', { name: /xnew/ });
    return { user, row };
  };

  it('新建超管显示待批准：发起人、目标角色、到期时间', async () => {
    replies[LIST] = [{ body: { accounts: [pendingRow()] } }];
    const { row } = await mount();
    expect(row).toHaveTextContent('待批准');
    expect(row).toHaveTextContent('运维超管');
    expect(row).toHaveTextContent('roota 发起');
    expect(row).toHaveTextContent('2027/01/22');
    expect(within(row).getByRole('button', { name: '拒绝' })).toBeEnabled();
  });

  it('新建账号选超管也提示要批准', async () => {
    replies[LIST] = [{ body: { accounts: [] } }];
    install(me('rootb', ['ops.account.manage']));
    const user = userEvent.setup();
    page(<AccountsPage />);
    await user.click(await screen.findByRole('button', { name: '新建账号' }));
    const dlg = await screen.findByRole('dialog', { name: '新建账号', hidden: true });
    await user.click(within(dlg).getByLabelText('运维超管'));
    expect(dlg).toHaveTextContent('授予运维超管需要另一名运维超管批准后才生效');
  });

  it('拒绝要填理由；4038 走 TOTP 后重放；请求带角色和理由；成功后刷新', async () => {
    replies[LIST] = [{ body: { accounts: [pendingRow()] } }, { body: { accounts: [clean] } }];
    replies[`POST ${ROLES}/reject`] = [stepUpRequired, { body: { role: 'ops_superadmin' } }];
    const { user, row } = await mount();
    await user.click(within(row).getByRole('button', { name: '拒绝' }));
    const dlg = await screen.findByRole('dialog', { name: '拒绝 xnew 的角色', hidden: true });
    const submit = within(dlg).getByRole('button', { name: '拒绝', hidden: true });
    expect(submit).toBeDisabled();
    await user.type(within(dlg).getByLabelText('理由'), 'abc');
    expect(submit).toBeDisabled();
    expect(posts(`${ROLES}/reject`)).toHaveLength(0);
    await user.type(within(dlg).getByLabelText('理由'), 'd 审批记录不符');
    expect(submit).toBeEnabled();
    await user.click(submit);
    await passStepUp(user);
    await waitFor(() => expect(posts(`${ROLES}/reject`)).toHaveLength(2));
    expect(posts(`${ROLES}/reject`)[1]!.body).toEqual({ role: 'ops_superadmin', reason: 'abcd 审批记录不符' });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '拒绝 xnew 的角色', hidden: true })).toBeNull());
    await waitFor(() => expect(screen.getByRole('row', { name: /xnew/ })).not.toHaveTextContent('待批准'));
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('发起人看到的是撤回，请求同一个接口', async () => {
    replies[LIST] = [{ body: { accounts: [pendingRow()] } }];
    const { row } = await mount('roota');
    expect(within(row).queryByRole('button', { name: '拒绝' })).toBeNull();
    expect(within(row).getByRole('button', { name: '撤回' })).toBeEnabled();
  });

  it.each([
    ['批准', '批准 xnew 的角色', 'approve'],
    ['拒绝', '拒绝 xnew 的角色', 'reject'],
  ])('%s时已过期或已处理（4093）：提示并刷新列表，不留在框里', async (button, title, verb) => {
    replies[LIST] = [{ body: { accounts: [pendingRow()] } }, { body: { accounts: [clean] } }];
    replies[`POST ${ROLES}/${verb}`] = [{ status: 409, body: { code: 4093, msg: 'no pending grant' } }];
    const { user, row } = await mount();
    await user.click(within(row).getByRole('button', { name: button }));
    const dlg = await screen.findByRole('dialog', { name: title, hidden: true });
    if (verb === 'reject') await user.type(within(dlg).getByLabelText('理由'), '审批记录不符');
    await user.click(within(dlg).getByRole('button', { name: button, hidden: true }));
    expect(await screen.findByRole('status')).toHaveTextContent('这条待批准已经失效');
    expect(screen.queryByRole('dialog', { name: title, hidden: true })).toBeNull();
    expect(listCalls()).toHaveLength(2);
    expect(screen.getByRole('row', { name: /xnew/ })).not.toHaveTextContent('待批准');
  });

  it('其他错误还是留在框里，不当成已失效', async () => {
    replies[LIST] = [{ body: { accounts: [pendingRow()] } }];
    replies[`POST ${ROLES}/approve`] = [{ status: 403, body: { code: 4030, reason: 'ownGrant' } }];
    const { user, row } = await mount();
    await user.click(within(row).getByRole('button', { name: '批准' }));
    const dlg = await screen.findByRole('dialog', { name: '批准 xnew 的角色', hidden: true });
    await user.click(within(dlg).getByRole('button', { name: '批准', hidden: true }));
    expect(await within(dlg).findByText('不能批准自己发起的授予，需要另一名运维超管批准')).toBeVisible();
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('改角色：要替换现有角色的待批准按批准之后的角色勾选，不会勾出互斥组合', async () => {
    const row = pendingRow(
      { status: 'active', roles: ['ops_viewer'] },
      { role: 'ops_superadmin', replaces: ['ops_viewer'] },
    );
    replies[LIST] = [{ body: { accounts: [row] } }];
    const { user, row: tr } = await mount();
    expect(tr).toHaveTextContent('只读');
    await user.click(within(tr).getByRole('button', { name: '改角色' }));
    const dlg = await screen.findByRole('dialog', { name: '修改 xnew 的角色', hidden: true });
    expect(within(dlg).getByLabelText('运维超管')).toBeChecked();
    expect(within(dlg).getByLabelText('只读')).not.toBeChecked();
  });
});

describe('审计导出（FE-521、AC-OPS-15-8）', () => {
  const saved: { name: string; blob: Blob }[] = [];
  beforeEach(() => {
    saved.length = 0;
    vi.stubGlobal(
      'URL',
      Object.assign(URL, {
        createObjectURL: vi.fn(() => 'blob:x'),
        revokeObjectURL: vi.fn(),
      }),
    );
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      saved.push({ name: this.download, blob: new Blob() });
    });
  });
  afterEach(() => vi.restoreAllMocks());

  const csv: Reply = {
    body: null,
    raw: '﻿seq,time\n1,x\n',
    headers: { 'Content-Type': 'text/csv', 'Content-Disposition': 'attachment; filename="audit-ops-1.csv"' },
  };

  it('4038 走 TOTP 后重放；用当前筛选条件；文件名来自响应头；不进 URL', async () => {
    install(me('aud', ['ops.audit.read']));
    replies['POST /console/api/audit/export'] = [stepUpRequired, csv];
    const user = userEvent.setup();
    page(<AuditPage />);
    await user.type(screen.getByLabelText('操作人'), 'eng1');
    await user.type(screen.getByLabelText('目标'), 'user:u1');
    await user.selectOptions(screen.getByLabelText('来源'), 'all');
    await user.click(screen.getByRole('button', { name: '导出 CSV' }));
    await passStepUp(user);
    await waitFor(() => expect(saved).toHaveLength(1));
    expect(saved[0]!.name).toBe('audit-ops-1.csv');
    expect(await screen.findByText('audit-ops-1.csv')).toBeVisible();
    const [first, second] = posts('/console/api/audit/export');
    expect(second!.body).toEqual(first!.body);
    expect(second!.body).toMatchObject({ actor: 'eng1', target: 'user:u1', space: 'all' });
    expect(typeof second!.body!.from).toBe('number');
    expect(calls.some((c) => c.path.includes('u1'))).toBe(false);
  });

  it('超过 1 万条：显示原因，没有文件', async () => {
    install(me('aud', ['ops.audit.read']));
    replies['POST /console/api/audit/export'] = [{ status: 400, body: { code: 4131, reason: 'auditExportTooMany' } }];
    const user = userEvent.setup();
    page(<AuditPage />);
    await user.click(screen.getByRole('button', { name: '导出 CSV' }));
    expect(await screen.findByText(/超过 1 万条/)).toBeVisible();
    expect(saved).toHaveLength(0);
  });

  it('时间范围超过 31 天：导出按钮不可点', async () => {
    install(me('aud', ['ops.audit.read']));
    const user = userEvent.setup();
    page(<AuditPage />);
    const from = screen.getByLabelText('开始时间');
    await user.clear(from);
    await user.type(from, '2020-01-01T00:00');
    expect(screen.getByRole('button', { name: '导出 CSV' })).toBeDisabled();
  });
});
