# tianting-ops

天听运维后台：总览、节点、指标入口、连接排查、告警静默、配置检查、数据库与备份、审计、账号管理。**天听**是自研 IM 平台，替换腾讯 IM。

|            |                                                                                                                                    |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| 状态       | 第一批页面完成（FE-500～FE-506）；第二批和 P1 完成：告警静默（FE-520）、双人批准和审计导出（FE-521）                               |
| 技术       | React + Vite + TypeScript，没有组件库                                                                                              |
| 后端       | 只调用 console-server 的 `/console/api/*`（同源、Cookie 会话）。**浏览器里没有任何节点凭证**，节点运维接口只有 console-server 能调 |
| 需求和任务 | tianting-server 的 `docs/prd/PRD-ops-v1.1.md`、`docs/tasks/frontend-ops.md`                                                        |

## 约定

- **CSP 比管理后台更严**：`style-src 'self'`、`img-src 'self'`，没有 nonce，也不允许 `data:`。样式全在 `src/app.css`，二维码是内联 SVG。
- **不加载任何外部资源**：`npm run check:dist` 扫描构建产物。
- **数据不可用不显示 0**：卡片显示"数据不可用"和原因；告警不可用绝不显示"当前没有告警"。
- **有节点没响应不说"不在线"**：`partial` 时只说在已响应的节点上没找到。
- **排查的 userId、工单号、理由不进 URL**：只在 POST 请求体和组件状态里。
- **自动刷新**带 `X-Console-Background: 1`，不续期空闲计时；页面不可见时停止。
- **谁能批准只由服务端判断**：发起人也能点"批准"，收到 4030 后显示在框内（FE-521）。待批准的角色没有生效，账号状态以服务端的 `pendingRoles` 为准。
- **审计导出的筛选条件在 POST 请求体里**，不进 URL。文件只在内存里，交给浏览器保存。
- **关闭码含义**来自协议：`node scripts/gen-close-codes.mjs` 从 `errors.json` 生成 `src/lib/closeCodes.ts`，不手抄。

和 tianting-admin 共用的页面（登录、账号、审计、通知、设置）和基础组件目前是复制的，两边改动要同步。

## 开发和测试

```bash
npm install
```

```bash
npm run lint && npm test && npm run build && npm run check:dist
```

```bash
npm run e2e
```

`e2e/stack.mjs` 启动真实的 console-server、两个 im-server（n1、n2）和 Postgres。Prometheus、Alertmanager、备份桶和 Grafana 在开发机上没有，用假服务代替，真实联调要等测试环境（tianting-server BE-320）。

## 部署

构建产物 `dist/` 由 console-server 托管（`CON_OPS_WEB_DIR`）。
