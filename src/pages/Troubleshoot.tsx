import { useState, type FormEvent } from 'react';
import { api } from '../api/client';
import { isUnavailable, type Envelope, type TroubleshootResult } from '../api/ops';
import { PageError, PartialBanner } from '../components/Common';
import { Badge, Empty, Field, Text } from '../components/ui';
import { closeCodeMeaning } from '../lib/closeCodes';
import { formatDuration, formatTime, idPattern, reasonValid, ticketPattern } from '../lib/format';

const QUEUE_BACKLOG = 16;

function Verdict({ env }: { env: Envelope<TroubleshootResult> }) {
  const d = env.data;
  if (d.verdict === 'offline') {
    return (
      <p className="note note-warn" role="status">
        当前不在线。可以看下面的断开记录了解最近发生了什么。
      </p>
    );
  }
  if (d.verdict === 'unknown') {
    // 有节点没响应时不能说"不在线"（F-OPS-08 规则 4）。
    return (
      <p className="note note-warn" role="status">
        在已响应的 {d.respondedNodes} 个节点上未找到连接；节点 <Text>{env.missingNodes.join('、')}</Text>{' '}
        未响应，结果可能不完整
      </p>
    );
  }
  return null;
}

/** userId、工单号、理由只在 POST 请求体和组件状态里：不进 URL、路由状态、浏览器历史和本地存储。 */
export function TroubleshootPage() {
  const [userId, setUserId] = useState('');
  const [ticket, setTicket] = useState('');
  const [reason, setReason] = useState('');
  const [env, setEnv] = useState<Envelope<TroubleshootResult> | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const idBad = userId.trim() !== '' && !idPattern.test(userId.trim());
  const ticketBad = ticket.trim() !== '' && !ticketPattern.test(ticket.trim());
  const reasonBad = reason !== '' && !reasonValid(reason);
  const ok = idPattern.test(userId.trim()) && ticketPattern.test(ticket.trim()) && reasonValid(reason);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!ok) return;
    setBusy(true);
    setError(null);
    setEnv(null);
    try {
      setEnv(
        await api<Envelope<TroubleshootResult>>('POST', '/console/api/ops/v1/troubleshoot/query', {
          userId: userId.trim(),
          ticket: ticket.trim(),
          reason: reason.trim(),
        }),
      );
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  const d = env?.data;
  const now = env?.dataTime ?? 0;
  return (
    <>
      <h1>连接排查</h1>
      <p className="muted">查询会写审计。每天最多查 50 个不同的用户。这里只能看，需要踢人请使用管理后台。</p>
      <form className="panel filters" onSubmit={submit}>
        <Field label="userId" error={idBad ? 'userId 只能用字母、数字、_、-，最长 64 位' : null}>
          {(id) => <input id={id} value={userId} onChange={(e) => setUserId(e.target.value)} autoComplete="off" />}
        </Field>
        <Field label="工单号" error={ticketBad ? '工单号是 3～32 位字母、数字、_、-' : null}>
          {(id) => <input id={id} value={ticket} onChange={(e) => setTicket(e.target.value)} autoComplete="off" />}
        </Field>
        <Field label="理由" error={reasonBad ? '理由需要 4～200 个字符，不能由同一个字符重复组成' : null}>
          {(id) => <input id={id} value={reason} onChange={(e) => setReason(e.target.value)} autoComplete="off" />}
        </Field>
        <div className="filters-submit">
          <button className="btn btn-primary" type="submit" disabled={!ok || busy}>
            {busy ? '查询中…' : '查询'}
          </button>
        </div>
      </form>
      <PageError error={error} />
      {env && d && (
        <>
          {env.partial && d.verdict === 'onlinePartial' && <PartialBanner missing={env.missingNodes} />}
          <Verdict env={env} />
          {d.connections.length > 0 && (
            <section className="panel">
              <h2>当前连接（{d.connections.length}）</h2>
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>连接 ID</th>
                      <th>平台</th>
                      <th>节点</th>
                      <th>建立时间</th>
                      <th>在线时长</th>
                      <th>IP（已脱敏）</th>
                      <th>下行队列</th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.connections.map((c) => (
                      <tr key={c.connId}>
                        <td className="mono">
                          <Text>{c.connId}</Text>
                        </td>
                        <td>
                          <Text>{c.platform}</Text>
                        </td>
                        <td>
                          <Text>{c.node}</Text>
                        </td>
                        <td className="nowrap">{formatTime(c.connectedAt)}</td>
                        <td>{formatDuration(now - c.connectedAt)}</td>
                        <td>
                          <Text>{c.ip}</Text>
                        </td>
                        <td>{c.queueLen > QUEUE_BACKLOG ? <Badge tone="warn">积压中</Badge> : '正常'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}
          <section className="panel">
            <h2>最近断开记录（{d.disconnects.length}）</h2>
            {d.summary.codes.length > 0 && (
              <p>关闭码汇总：{d.summary.codes.map((c) => `${c.code} × ${c.count}`).join('，')}</p>
            )}
            {d.summary.serverClosedMajority && <p className="note note-warn">多数断开由服务端发起，请对照关闭码说明</p>}
            {d.summary.handshakeAuthMajority && (
              <p className="note note-warn">客户端可能在凭证失效后仍在反复重连，请检查是否处理了 kicked</p>
            )}
            {d.disconnects.length === 0 ? (
              <Empty>没有断开记录</Empty>
            ) : (
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>时间</th>
                      <th>阶段</th>
                      <th>连接 ID</th>
                      <th>平台</th>
                      <th>节点</th>
                      <th>关闭码</th>
                      <th>含义</th>
                      <th>原因</th>
                      <th>关闭方</th>
                      <th>在线时长</th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.disconnects.map((r, i) => (
                      <tr key={`${r.node}-${r.ts}-${i}`}>
                        <td className="nowrap">{formatTime(r.ts)}</td>
                        <td>{r.phase === 'handshake' ? '握手阶段' : '会话中'}</td>
                        <td className="mono">{r.phase === 'handshake' ? '—' : <Text>{r.connId}</Text>}</td>
                        <td>
                          <Text>{r.platform}</Text>
                        </td>
                        <td>
                          <Text>{r.node}</Text>
                        </td>
                        <td>{r.code}</td>
                        <td>{closeCodeMeaning[r.code] ?? '—'}</td>
                        <td>
                          <Text>{r.reason || '—'}</Text>
                        </td>
                        <td>{r.by === 'server' ? '服务端' : r.by === 'client' ? '客户端' : <Text>{r.by}</Text>}</td>
                        <td>{r.phase === 'handshake' ? '—' : formatDuration(r.durationMs)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <p className="muted">
              数据范围：每个节点最近约 2 万条、每个用户最近 50 条；节点重启后清空；缓冲最早一条：
              {Object.entries(d.bufferFrom)
                .sort()
                .map(([node, at]) => `${node} ${at ? formatTime(at) : '—'}`)
                .join('，') || '—'}
              ；更早的记录请查日志。
            </p>
          </section>
          <section className="panel">
            <h2>本页无法按用户归属的握手拒绝（最近 1 小时）</h2>
            {isUnavailable(d.unattributed) ? (
              <p className="unavailable">
                数据不可用（<Text>{d.unattributed.reason}</Text>）
              </p>
            ) : (
              <p>
                4401 × {d.unattributed.counts['4401'] ?? 0}，4010 × {d.unattributed.counts['4010'] ?? 0}，4009 ×{' '}
                {d.unattributed.counts['4009'] ?? 0}
              </p>
            )}
            <p className="muted">这类拒绝发生时服务端还不知道或不能信任 userId，所以只有全部节点的汇总数字。</p>
          </section>
        </>
      )}
    </>
  );
}
