// 端到端环境：真实的 Postgres + 两个 im-server（n1、n2，测试模式）+ console-server（只开运维空间，托管 dist/，响应头就是生产的 CSP）。
// Prometheus、Alertmanager、备份桶、Grafana 在开发机上没有，用这里的假服务（只模拟接口，能开关）。
// 这些组件的真实联调要等测试环境（BE-320）。
import { execFileSync, spawn } from 'node:child_process';
import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import pg from 'pg';

const imDir = resolve(
  process.env.TIANTING_SERVER_DIR ??
    (existsSync('../tianting-server/server') ? '../tianting-server/server' : '../im-mvp/server'),
);
const consoleDir = resolve(process.env.TIANTING_CONSOLE_DIR ?? '../tianting-console-server');
const adminUrl = process.env.CON_TEST_ADMIN_URL ?? 'postgres://127.0.0.1:5432/postgres?sslmode=disable';
const work = mkdtempSync(join(tmpdir(), 'tt-ops-e2e-'));
const P = {
  console: 18290,
  control: 18299,
  prom: 18295,
  am: 18296,
  s3: 18297,
  grafana: 18298,
  n1: { ws: 18280, admin: 18281, ops: 18282 },
  n2: { ws: 18283, admin: 18284, ops: 18285 },
};
const legacy = 'tianting-e2e-legacy-key';
const origin = `http://ops.localhost:${P.console}`;

// 端口被别的进程占着时直接失败：否则测试可能连到别人的服务，只看到难懂的 401。
async function assertPortsFree(list) {
  const busy = await Promise.all(
    list.map(
      (port) =>
        new Promise((done) => {
          const s = connect({ host: '127.0.0.1', port });
          s.setTimeout(1000, () => (s.destroy(), done(null)));
          s.once('connect', () => (s.destroy(), done(port)));
          s.once('error', () => done(null));
        }),
    ),
  );
  const taken = busy.filter(Boolean);
  if (taken.length > 0) {
    console.error(`e2e ports already in use: ${taken.join(', ')}`);
    process.exit(1);
  }
}
await assertPortsFree([
  P.console,
  P.control,
  P.prom,
  P.am,
  P.s3,
  P.grafana,
  P.n1.ws,
  P.n1.admin,
  P.n1.ops,
  P.n2.ws,
  P.n2.admin,
  P.n2.ops,
]);

const go = (dir, out, pkg) => execFileSync('go', ['build', '-o', join(work, out), pkg], { cwd: dir, stdio: 'inherit' });
go(imDir, 'im-server', './cmd/im-server');
go(consoleDir, 'console-server', './cmd/console-server');

function nodeKeys() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const seed = privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(16);
  const pub = publicKey.export({ format: 'der', type: 'spki' }).subarray(12);
  return { seed: seed.toString('base64'), pub: pub.toString('base64') };
}

const nodes = {};
const table = [];
for (const id of ['n1', 'n2']) {
  const k = nodeKeys();
  const keyFile = join(work, `${id}.key`);
  writeFileSync(keyFile, k.seed, { mode: 0o600 });
  nodes[id] = k;
  table.push({ nodeId: id, addr: `127.0.0.1:${P[id].ops}`, kid: 'k1', keyFile });
}
const tableFile = join(work, 'nodes.json');
writeFileSync(tableFile, JSON.stringify(table), { mode: 0o600 });

// 假 Prometheus：按查询语句回固定结果，可以关掉。
const state = {
  promDown: false,
  amDown: false,
  s3Down: false,
  alerts: [],
  silences: new Map(),
  amRequests: [],
  manifests: new Map(),
  grafanaHits: [],
};
const vec = (rows) => rows.map(([code, v]) => ({ metric: code ? { code } : {}, value: [1, String(v)] }));
createServer((req, res) => {
  if (state.promDown) {
    res.writeHead(503).end();
    return;
  }
  const q = new URL(req.url, 'http://x').searchParams.get('query') ?? '';
  let rows = [];
  if (q.includes('rate(im_messages_total')) rows = [['', 10]];
  else if (q.includes('increase(im_messages_total')) rows = [['', 1200]];
  else if (q.includes('im_commands_total'))
    rows = [
      ['0', 21],
      ['4290', 9],
    ];
  else if (q.includes('code=~'))
    rows = [
      ['4401', 3],
      ['4010', 1],
    ];
  else if (q.includes('phase="handshake"'))
    rows = [
      ['4011', 5],
      ['4401', 3],
    ];
  else if (q.includes('phase="session"'))
    rows = [
      ['1000', 7],
      ['4012', 2],
    ];
  res.end(JSON.stringify({ status: 'success', data: { resultType: 'vector', result: vec(rows) } }));
}).listen(P.prom, '127.0.0.1');

// 假 Alertmanager：符合 v2 API 的告警和静默接口，校验请求内容，记下收到的请求。真实的要到测试环境（tools/ops-accept 的 silence 步骤）。
createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const text = Buffer.concat(chunks).toString();
  const path = new URL(req.url, 'http://x').pathname;
  state.amRequests.push({ method: req.method, path, body: text ? JSON.parse(text) : null });
  if (state.amDown) {
    res.writeHead(503).end();
    return;
  }
  const one = /^\/api\/v2\/silence\/([^/]+)$/.exec(path);
  if (req.method === 'GET' && path === '/api/v2/alerts') {
    res.end(JSON.stringify(state.alerts));
  } else if (req.method === 'GET' && path === '/api/v2/silences') {
    res.end(JSON.stringify([...state.silences.values()]));
  } else if (req.method === 'POST' && path === '/api/v2/silences') {
    const b = JSON.parse(text);
    const valid =
      Array.isArray(b.matchers) &&
      b.matchers.length > 0 &&
      b.matchers.every((m) => m.name && typeof m.value === 'string' && typeof m.isRegex === 'boolean') &&
      b.createdBy &&
      b.comment &&
      Date.parse(b.endsAt) > Date.parse(b.startsAt);
    if (!valid) {
      res.writeHead(400).end('invalid silence');
      return;
    }
    const id = randomUUID();
    state.silences.set(id, { ...b, id, status: { state: 'active' } });
    res.end(JSON.stringify({ silenceID: id }));
  } else if (one && state.silences.has(one[1])) {
    if (req.method === 'DELETE') state.silences.get(one[1]).status.state = 'expired';
    res.end(req.method === 'GET' ? JSON.stringify(state.silences.get(one[1])) : '');
  } else {
    res.writeHead(404).end();
  }
}).listen(P.am, '127.0.0.1');

// 假备份桶：真实的签名和权限在 console-server 的 Go 测试里校验过，这里只回内容。
createServer((req, res) => {
  if (state.s3Down) {
    res.writeHead(503).end('<Error><Code>ServiceUnavailable</Code></Error>');
    return;
  }
  const u = new URL(req.url, 'http://x');
  const key = decodeURIComponent(u.pathname).replace(/^\/ops-backup\/?/, '');
  if (key === '') {
    const prefix = u.searchParams.get('prefix') ?? '';
    const keys = [...state.manifests.keys()].filter((k) => k.startsWith(prefix)).sort();
    res.end(
      `<ListBucketResult><IsTruncated>false</IsTruncated>${keys.map((k) => `<Contents><Key>${k}</Key></Contents>`).join('')}</ListBucketResult>`,
    );
    return;
  }
  if (!state.manifests.has(key)) {
    res.writeHead(404).end('<Error><Code>NoSuchKey</Code></Error>');
    return;
  }
  res.end(state.manifests.get(key));
}).listen(P.s3, '127.0.0.1');

// 假 Grafana：回显身份头。
createServer((req, res) => {
  state.grafanaHits.push({ url: req.url, user: req.headers['x-webauth-user'] ?? '' });
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(`<!doctype html><title>Grafana</title><h1 id="who">Grafana:${req.headers['x-webauth-user'] ?? ''}</h1>`);
}).listen(P.grafana, '127.0.0.1');

const dbName = 'tt_ops_e2e_' + randomBytes(4).toString('hex');
const admin = new pg.Client({ connectionString: adminUrl });
await admin.connect();
await admin.query(`CREATE DATABASE ${dbName}`);
const withDb = (user) => {
  const u = new URL(adminUrl);
  u.pathname = '/' + dbName;
  if (user) u.username = user;
  return u.toString();
};
const consoleEnv = {
  ...process.env,
  CON_OWNER_DATABASE_URL: withDb(),
  CON_DATABASE_URL: withDb('console_app'),
  CON_TEST_MODE: '1',
  CON_TEST_DISABLE_LOCKOUT: '1',
  CON_SPACES: 'ops',
  CON_OPS_ADDR: `127.0.0.1:${P.console}`,
  CON_OPS_ORIGIN: origin,
  CON_OPS_WEB_DIR: resolve('dist'),
  CON_METRICS_ADDR: 'off',
  CON_ARGON_MEMORY_KIB: '1024',
  CON_ARGON_TIME: '1',
  CON_DATA_KEYS: 'k1:' + Buffer.alloc(32, 'd').toString('base64'),
  CON_HASH_PEPPER: Buffer.alloc(32, 'p').toString('base64'),
  CON_OPS_NODES: tableFile,
  CON_OPS_PROMETHEUS_URL: `http://127.0.0.1:${P.prom}`,
  CON_OPS_ALERTMANAGER_URL: `http://127.0.0.1:${P.am}`,
  CON_OPS_BACKUP_STORE: 's3://ops-backup',
  CON_OPS_BACKUP_ENDPOINT: `http://127.0.0.1:${P.s3}`,
  CON_OPS_BACKUP_ACCESS_KEY: 'reader',
  CON_OPS_BACKUP_SECRET_KEY: 'reader-secret',
  CON_OPS_GRAFANA_URL: `http://127.0.0.1:${P.grafana}`,
  CON_OPS_GRAFANA_HOST: `grafana.ops.localhost:${P.console}`,
};
execFileSync(join(work, 'console-server'), ['migrate', 'up'], { env: consoleEnv, stdio: 'inherit' });
await admin.query('ALTER ROLE console_app LOGIN');

const imProc = (id, env = {}) =>
  spawn(join(work, 'im-server'), [], {
    stdio: 'inherit',
    env: {
      ...process.env,
      IM_ADDR: `127.0.0.1:${P[id].ws}`,
      IM_ADMIN_ADDR: `127.0.0.1:${P[id].admin}`,
      IM_OPS_ADDR: `127.0.0.1:${P[id].ops}`,
      IM_OPS_PUBKEYS: `k1:${nodes[id].pub}`,
      IM_NODE_ID: id,
      IM_METRICS_ADDR: 'off',
      IM_PPROF_ADDR: 'off',
      IM_DB: join(work, `${id}.db`),
      IM_TEST_MODE: '1',
      IM_ADMIN_KEY: legacy,
      IM_ALLOWED_ORIGINS: '*',
      ...env,
    },
  });
const procs = {
  n1: imProc('n1'),
  n2: imProc('n2'),
  console: spawn(join(work, 'console-server'), [], { stdio: 'inherit', env: consoleEnv }),
};

writeFileSync(
  new URL('./.state.json', import.meta.url),
  JSON.stringify({
    origin,
    control: `http://127.0.0.1:${P.control}`,
    n1: { admin: `http://127.0.0.1:${P.n1.admin}`, ws: `127.0.0.1:${P.n1.ws}` },
    n2: { admin: `http://127.0.0.1:${P.n2.admin}`, ws: `127.0.0.1:${P.n2.ws}` },
    legacy,
    clock: Date.now(),
  }),
);

// 控制接口：测试用它开关假服务、暂停节点、创建第一个超管。
createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
  switch (u.pathname) {
    case '/fake':
      Object.assign(state, body);
      res.end('{}');
      return;
    case '/manifest':
      state.manifests.set(
        `manifests/${body.source}/${String(body.finishedAt).padStart(13, '0')}.json`,
        JSON.stringify(body),
      );
      res.end('{}');
      return;
    case '/manifests/clear':
      state.manifests.clear();
      res.end('{}');
      return;
    case '/am-requests':
      res.end(JSON.stringify(state.amRequests));
      return;
    case '/grafana-hits':
      res.end(JSON.stringify(state.grafanaHits));
      return;
    case '/signal':
      procs[body.node].kill(body.signal);
      res.end('{}');
      return;
    case '/bootstrap': {
      const out = execFileSync(
        join(work, 'console-server'),
        ['account', 'bootstrap', '--space', 'ops', '--username', body.username],
        { env: consoleEnv },
      )
        .toString()
        .trim();
      res.end(JSON.stringify({ code: out.split(': ').pop() }));
      return;
    }
    case '/healthz':
      res.end('ok');
      return;
  }
  res.writeHead(404).end();
}).listen(P.control, '127.0.0.1');

let closing = false;
const stop = async () => {
  if (closing) return;
  closing = true;
  for (const p of Object.values(procs)) {
    p.kill('SIGCONT');
    p.kill('SIGKILL');
  }
  await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`).catch(() => undefined);
  await admin.end().catch(() => undefined);
  process.exit(0);
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
procs.console.on('exit', (c) => !closing && (console.error('console-server exited', c), stop()));
