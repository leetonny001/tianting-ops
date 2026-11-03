# tianting-ops

天听运维后台 H5。**天听**是自研 IM 平台，替换腾讯 IM（聊天、群聊、聊天室、站内推送）。

运维用的后台：节点与在线连接排查、配置检查、备份记录（只读）、审计；图表和告警用 Grafana + Prometheus + Alertmanager。

| | |
|---|---|
| 状态 | 尚未开始，排在工作队列 Q14、Q15 |
| 技术 | React，只调用后台服务（console-server，部署在内网 / VPN 后） |
| 服务端、协议、需求文档 | [tianting-server](https://github.com/leetonny001/tianting-server) |
| 工作队列 / 日报 | tianting-server 的 `docs/process/QUEUE.md`、`docs/reports/daily/` |

需求：tianting-server 的 `docs/prd/PRD-ops`，拍板项 O-1、O-2 见 `docs/review/DECISIONS-2026-11-03.md`。

## 天听的项目

| 仓库 | 内容 |
|---|---|
| [tianting-server](https://github.com/leetonny001/tianting-server) | Go 服务端、协议、需求 / 架构 / 测试文档 |
| [tianting-sdk-ts](https://github.com/leetonny001/tianting-sdk-ts) | SDK（TypeScript）：H5、PC |
| [tianting-sdk-kotlin](https://github.com/leetonny001/tianting-sdk-kotlin) | SDK（Kotlin）：Android |
| [tianting-sdk-swift](https://github.com/leetonny001/tianting-sdk-swift) | SDK（Swift）：iOS |
| [tianting-web](https://github.com/leetonny001/tianting-web) | H5 客户端 |
| [tianting-desktop](https://github.com/leetonny001/tianting-desktop) | PC 客户端 |
| [tianting-android](https://github.com/leetonny001/tianting-android) | Android 客户端 |
| [tianting-ios](https://github.com/leetonny001/tianting-ios) | iOS 客户端 |
| [tianting-admin](https://github.com/leetonny001/tianting-admin) | 管理后台 H5 |
| [tianting-ops](https://github.com/leetonny001/tianting-ops) | 运维后台 H5 |
