import { createHmac } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { expect, type Page } from '@playwright/test';

const statePath = new URL('./.state.json', import.meta.url);
interface NodeAddr {
  admin: string;
  ws: string;
}
interface State {
  origin: string;
  control: string;
  n1: NodeAddr;
  n2: NodeAddr;
  legacy: string;
  clock: number;
  accounts?: Record<string, Account>;
  paused?: string[];
}
export const readState = (): State => JSON.parse(readFileSync(statePath, 'utf8'));
const writeState = (s: State) => writeFileSync(statePath, JSON.stringify(s));

export const PASSWORD = 'Correct-Horse-9-Battery';
export const REASON = '用户反馈掉线';
export const TICKET = 'CS-1024';

export interface Account {
  username: string;
  password: string;
  seed: string;
  id: string;
  recovery: string[];
}

export async function control(path: string, body: unknown = {}) {
  const r = await fetch(readState().control + path, { method: 'POST', body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`control ${path}: ${r.status}`);
  return r.json();
}

/** 三个时钟一起拨：先 IM 后 console。 */
export async function setClocks(now: number) {
  const s = readState();
  for (const id of ['n1', 'n2'] as const) {
    if (s.paused?.includes(id)) continue; // SIGSTOP 的进程不会响应，等下去就挂住了
    const n = s[id];
    const r = await fetch(`${n.admin}/admin/test/clock`, {
      method: 'POST',
      headers: { 'X-Admin-Key': s.legacy },
      body: JSON.stringify({ nowMs: now }),
    });
    if (!r.ok) throw new Error(`im clock ${r.status}`);
  }
  const r = await fetch(`${s.origin}/console/test/clock`, { method: 'POST', body: JSON.stringify({ nowMs: now }) });
  if (!r.ok) throw new Error(`console clock ${r.status}`);
  s.clock = now;
  writeState(s);
}

export async function tick(ms = 31_000) {
  await setClocks(readState().clock + ms);
}

export const clockNow = () => readState().clock;

/** 暂停一个节点（kill -STOP）。恢复时把时钟补上。 */
export async function pauseNode(id: 'n1' | 'n2') {
  const s = readState();
  s.paused = [...(s.paused ?? []), id];
  writeState(s);
  await control('/signal', { node: id, signal: 'SIGSTOP' });
}

export async function resumeNode(id: 'n1' | 'n2') {
  await control('/signal', { node: id, signal: 'SIGCONT' });
  const s = readState();
  s.paused = (s.paused ?? []).filter((x) => x !== id);
  writeState(s);
  await new Promise((r) => setTimeout(r, 200));
  await setClocks(s.clock);
}

/** 推进 5 秒以上，探测一轮。 */
export async function probe() {
  await tick(6000);
  const r = await fetch(`${readState().origin}/console/test/probe`, { method: 'POST' });
  if (!r.ok) throw new Error(`probe ${r.status}`);
}

function base32Decode(text: string): Buffer {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const c of text.replace(/=+$/, '')) {
    value = ((value << 5) | alphabet.indexOf(c)) & 0xffff;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function totp(seed: string, at = readState().clock): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 30_000)));
  const h = createHmac('sha1', base32Decode(seed)).update(counter).digest();
  const off = h[h.length - 1]! & 15;
  return String((h.readUInt32BE(off) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

export async function freshOtp(seed: string) {
  await tick();
  return totp(seed);
}

/** 不经过浏览器的 console 客户端：造账号用。 */
export class Api {
  cookie = '';
  csrf = '';
  async call<T = Record<string, unknown>>(method: string, path: string, body?: unknown): Promise<T> {
    const s = readState();
    const headers: Record<string, string> = { Origin: s.origin };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (this.cookie) headers.Cookie = this.cookie;
    if (this.csrf) headers['X-CSRF-Token'] = this.csrf;
    const r = await fetch(s.origin + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const set = r.headers.get('set-cookie');
    if (set?.startsWith('__Host-ops_sid=')) this.cookie = set.split(';')[0]!;
    const text = await r.text();
    const data = text ? JSON.parse(text) : {};
    if (!r.ok) throw new Error(`${method} ${path}: ${r.status} ${text}`);
    if (data.csrfToken) this.csrf = data.csrfToken;
    return data as T;
  }
}

export async function activate(username: string, code: string): Promise<{ api: Api; account: Account }> {
  const api = new Api();
  await api.call('POST', '/console/api/auth/activate', { username, code, newPassword: PASSWORD });
  const setup = await api.call<{ otpauthUri: string }>('POST', '/console/api/auth/totp/setup', {});
  const seed = new URL(setup.otpauthUri).searchParams.get('secret')!;
  const done = await api.call<{ account: { id: string }; recoveryCodes: string[] }>(
    'POST',
    '/console/api/auth/totp/confirm',
    { otp: await freshOtp(seed) },
  );
  return { api, account: { username, password: PASSWORD, seed, id: done.account.id, recovery: done.recoveryCodes } };
}

export function rootAccount(): Account {
  return readState().accounts!.root1!;
}

/** 运维超管：第一次用命令行创建。 */
export async function root(): Promise<Api> {
  const s = readState();
  if (!s.accounts?.root1) {
    await setClocks(s.clock);
    const { code } = (await control('/bootstrap', { username: 'root1' })) as { code: string };
    const { api, account } = await activate('root1', code);
    const next = readState();
    next.accounts = { ...next.accounts, root1: account };
    writeState(next);
    return api;
  }
  // 每次都重新登录：别的用例可能把时钟推进了很久，旧会话已经过期。
  return loginApi(s.accounts.root1);
}

export async function loginApi(a: Account): Promise<Api> {
  const api = new Api();
  await api.call('POST', '/console/api/auth/login', {
    username: a.username,
    password: a.password,
    otp: await freshOtp(a.seed),
  });
  return api;
}

/** 第二个运维超管：授予 ops_engineer 要另一个超管批准（AC-OPS-02-8）。第一次用到时创建。 */
export async function secondRoot(): Promise<Account> {
  const existing = readState().accounts?.root2;
  if (existing) return existing;
  const r = await root();
  await r.call('POST', '/console/api/auth/step-up', { otp: await freshOtp(rootAccount().seed) });
  const created = await r.call<{ activationCode: string }>('POST', '/console/api/accounts', {
    username: 'root2',
    displayName: 'root2',
    roles: ['ops_superadmin'],
  });
  const { account } = await activate('root2', created.activationCode);
  const next = readState();
  next.accounts = { ...next.accounts, root2: account };
  writeState(next);
  return account;
}

/** 第二个超管批准 ops_engineer。批准后这个账号的旧会话失效，所以造账号时先批准再激活。 */
export async function approveEngineer(accountId: string) {
  const a = await secondRoot();
  const b = await loginApi(a);
  await b.call('POST', '/console/api/auth/step-up', { otp: await freshOtp(a.seed) });
  await b.call('POST', `/console/api/accounts/${accountId}/roles/approve`, { role: 'ops_engineer' });
}

export async function provision(prefix: string, ...roles: string[]): Promise<Account> {
  const r = await root();
  await r.call('POST', '/console/api/auth/step-up', { otp: await freshOtp(rootAccount().seed) });
  const username = `${prefix}${Math.floor(Math.random() * 1e8)}`;
  const created = await r.call<{ id: string; activationCode: string }>('POST', '/console/api/accounts', {
    username,
    displayName: username,
    roles,
  });
  if (roles.includes('ops_engineer')) await approveEngineer(created.id);
  const { account } = await activate(username, created.activationCode);
  return account;
}

export async function login(page: Page, a: Account) {
  await page.goto('/login');
  await page.getByLabel('账号').fill(a.username);
  await page.getByLabel('密码').fill(a.password);
  await page.getByLabel('动态码').fill(await freshOtp(a.seed));
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByRole('navigation', { name: '主菜单' })).toBeVisible();
}

/** 收集 CSP 违规和 JS 报错。 */
export function watchPage(page: Page): string[] {
  const problems: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error' && /Content Security Policy|Content-Security-Policy/i.test(m.text()))
      problems.push(m.text());
  });
  page.on('pageerror', (e) => problems.push(String(e)));
  return problems;
}

export async function dial(node: 'n1' | 'n2', userId: string, platform: string) {
  const s = readState();
  const n = s[node];
  const r = await fetch(`${n.admin}/admin/users/token`, {
    method: 'POST',
    headers: { 'X-Admin-Key': s.legacy, 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId }),
  });
  const { token } = (await r.json()) as { token: string };
  const ws = new WebSocket(`ws://${n.ws}/ws?platform=${platform}`);
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener('open', () => ws.send(JSON.stringify({ id: 'auth', cmd: 'auth', data: { token } })));
    ws.addEventListener('message', (e) => {
      if (JSON.parse(String(e.data)).id === 'auth') resolve();
    });
    ws.addEventListener('error', () => reject(new Error('ws error')));
  });
  return ws;
}

export async function forceLogout(node: 'n1' | 'n2', userId: string) {
  const s = readState();
  const r = await fetch(`${s[node].admin}/admin/users/${userId}/force-logout`, {
    method: 'POST',
    headers: { 'X-Admin-Key': s.legacy },
    body: '{}',
  });
  if (!r.ok) throw new Error(`force-logout ${r.status}`);
}

export const uid = (p: string) => `${p}${Math.floor(Math.random() * 1e8)}`;
