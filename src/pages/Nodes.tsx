import type { NodeView, VersionsView } from '../api/ops';
import { PageError, PartialBanner, RefreshTools, useOpsData } from '../components/Common';
import { Badge, Empty, Text } from '../components/ui';
import { formatBytes, formatDuration, formatTime } from '../lib/format';

const statusBadge: Record<NodeView['status'], { text: string; tone: 'good' | 'warn' | 'bad' }> = {
  ready: { text: '就绪', tone: 'good' },
  draining: { text: '下线中', tone: 'warn' },
  notReady: { text: '未就绪', tone: 'warn' },
  unreachable: { text: '不可达', tone: 'bad' },
  identityFailed: { text: '未通过身份校验', tone: 'bad' },
};

/** 只读：没有重启、摘除、踢线（F-OPS-05 规则 4）。 */
export function NodesPage() {
  const { env, error, refresh, paused, setPaused } = useOpsData<{ nodes: NodeView[]; versions: VersionsView }>(
    '/console/api/ops/v1/nodes',
    true,
  );
  const list = env?.data.nodes;
  return (
    <>
      <div className="page-head">
        <h1>节点</h1>
        <RefreshTools refresh={refresh} paused={paused} setPaused={setPaused} dataTime={env?.dataTime} />
      </div>
      <PageError error={error} />
      {env && <PartialBanner missing={env.missingNodes} />}
      {list && list.length === 0 && <Empty>节点凭证表是空的</Empty>}
      {list && list.length > 0 && (
        <div className="table-scroll">
          <table className="nodes-table">
            <thead>
              <tr>
                <th>节点</th>
                <th>地址</th>
                <th>版本</th>
                <th>状态</th>
                <th>连接数</th>
                <th>启动时间 / 运行时长</th>
                <th>最后可见</th>
                <th title="heap 中存活对象 + 栈的估算，和每连接内存的容量规划同一口径">存活内存估算</th>
                <th title="Go 运行时堆和栈占用，含未回收的部分">堆 + 栈</th>
                <th>goroutine</th>
                <th>断开缓冲最早</th>
              </tr>
            </thead>
            <tbody>
              {list.map((n) => (
                <tr key={n.nodeId}>
                  <td>
                    <Text>{n.nodeId}</Text>
                  </td>
                  <td className="mono">
                    <Text>{n.addr}</Text>
                  </td>
                  <td>
                    <Text>{n.version || '—'}</Text>
                  </td>
                  <td>
                    <Badge tone={statusBadge[n.status].tone}>{statusBadge[n.status].text}</Badge>
                  </td>
                  <td>{n.lastSeenAt ? n.totalConns : '—'}</td>
                  <td className="nowrap">
                    {formatTime(n.startedAt)}
                    {n.startedAt > 0 && env && (
                      <div className="card-sub">{formatDuration(env.dataTime - n.startedAt)}</div>
                    )}
                  </td>
                  <td className="nowrap">{formatTime(n.lastSeenAt)}</td>
                  <td>{formatBytes(n.liveBytes)}</td>
                  <td>{formatBytes(n.heapBytes + n.stackBytes)}</td>
                  <td>{n.goroutines || '—'}</td>
                  <td className="nowrap">{formatTime(n.disconnectBufferFrom)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="muted">
        存活内存估算：堆中存活对象和栈的估算，容量规划用这个口径。堆 + 栈：Go 运行时占用，包含还没回收的部分。
      </p>
    </>
  );
}
