import { useState } from 'react';
import { Link } from 'react-router';
import { isUnavailable, type Overview } from '../api/ops';
import { errorText } from '../api/errors';
import { PageError, PartialBanner, RefreshTools, UnavailableNote, useOpsData } from '../components/Common';
import { openGrafana } from '../components/Layout';
import { Empty, Text } from '../components/ui';
import { formatDuration, formatTime } from '../lib/format';

const statusText = { ok: '正常', degraded: '降级', down: '不可用' };
const percent = (v: number) => `${(v * 100).toFixed(1)}%`;
const n = (v: number) => Math.round(v).toLocaleString('zh-CN');

function GrafanaLink({ label }: { label: string }) {
  const [error, setError] = useState('');
  return (
    <>
      <button
        type="button"
        className="link card-link"
        onClick={() => openGrafana().catch((e) => setError(errorText(e)))}
      >
        {label}
      </button>
      {error && (
        <span className="field-error" role="alert">
          {error}
        </span>
      )}
    </>
  );
}

export function OverviewPage() {
  const { env, error, refresh, paused, setPaused } = useOpsData<Overview>('/console/api/ops/v1/overview', true);
  const d = env?.data;
  return (
    <>
      <div className="page-head">
        <h1>总览</h1>
        <RefreshTools refresh={refresh} paused={paused} setPaused={setPaused} dataTime={env?.dataTime} />
      </div>
      <PageError error={error} />
      {env && <PartialBanner missing={env.missingNodes} />}
      {d && (
        <div className="cards">
          <section className="card" aria-label="服务状态">
            <h2>服务状态</h2>
            <div className={`card-big state-${d.status}`}>{statusText[d.status]}</div>
            <Link className="card-link" to="/nodes">
              查看节点
            </Link>
          </section>
          <section className={d.versions.mismatch ? 'card card-warn' : 'card'} aria-label="版本">
            <h2>版本</h2>
            <div className="card-big">
              <Text>{d.versions.list.join('、') || '—'}</Text>
            </div>
            {d.versions.mismatch && <div className="card-sub">版本不一致</div>}
            {d.versions.over30Min && <div className="card-sub">版本不一致已超过 30 分钟</div>}
          </section>
          <section className="card" aria-label="节点数">
            <h2>节点（就绪 / 总数）</h2>
            <div className="card-big">
              {d.nodes.ready} / {d.nodes.total}
            </div>
          </section>
          <section className="card" aria-label="在线连接">
            <h2>在线连接</h2>
            <div className="card-big">{n(d.connections.total)}</div>
            <div className="card-sub">
              {Object.entries(d.connections.byPlatform)
                .sort()
                .map(([p, c]) => `${p} ${c}`)
                .join('，') || '没有连接'}
            </div>
          </section>
          <section className="card" aria-label="消息量">
            <h2>消息量</h2>
            {isUnavailable(d.messages) ? (
              <UnavailableNote card={d.messages} />
            ) : (
              <>
                <div className="card-big">{d.messages.perSecond.toFixed(1)} 条/秒</div>
                <div className="card-sub">今日累计 {n(d.messages.today)} 条（今日按 Asia/Shanghai 自然日）</div>
              </>
            )}
            <GrafanaLink label="查看消息面板" />
          </section>
          <section className="card" aria-label="错误率">
            <h2>错误率（最近 5 分钟）</h2>
            {isUnavailable(d.errors) ? (
              <UnavailableNote card={d.errors} />
            ) : (
              <>
                <div className="card-big">
                  5xxx {percent(d.errors.share5xx)} · 4xxx {percent(d.errors.share4xx)}
                </div>
                <div className="card-sub">
                  前 3 错误码：{d.errors.top.map((t) => `${t.code} × ${n(t.count)}`).join('，') || '没有'}
                </div>
                <div className="card-sub">分母是全部命令，不含 auth 和心跳</div>
              </>
            )}
          </section>
          <section className="card" aria-label="握手与断开">
            <h2>握手与断开（最近 5 分钟）</h2>
            {isUnavailable(d.disconnects) ? (
              <UnavailableNote card={d.disconnects} />
            ) : (
              <>
                <div>
                  握手被拒：{d.disconnects.handshake.map((t) => `${t.code} × ${n(t.count)}`).join('，') || '没有'}
                </div>
                <div>
                  会话中断开：{d.disconnects.sessionTop3.map((t) => `${t.code} × ${n(t.count)}`).join('，') || '没有'}
                </div>
              </>
            )}
          </section>
          <section
            className={!isUnavailable(d.backup) && d.backup.sources.some((s) => s.overdue) ? 'card card-bad' : 'card'}
            aria-label="备份"
          >
            <h2>备份（最近一次成功）</h2>
            {isUnavailable(d.backup) ? (
              <UnavailableNote card={d.backup} />
            ) : d.backup.sources.length === 0 ? (
              <p className="unavailable">还没有备份记录</p>
            ) : (
              d.backup.sources.map((s) => (
                <div key={s.source}>
                  <Text>{s.source}</Text>：
                  {s.lastSuccessAt ? `${formatDuration((env?.dataTime ?? 0) - s.lastSuccessAt)}前` : '没有成功记录'}
                  {s.overdue && '（超过 2 小时）'}
                </div>
              ))
            )}
            <Link className="card-link" to="/database">
              查看备份记录
            </Link>
          </section>
          <section className="card" aria-label="告警">
            <h2>告警</h2>
            {isUnavailable(d.alerts) ? (
              <UnavailableNote card={d.alerts} text="告警数据不可用" />
            ) : d.alerts.list.length === 0 ? (
              <Empty>当前没有告警</Empty>
            ) : (
              <ul className="alert-list">
                {d.alerts.list.map((a) => (
                  <li key={`${a.name}-${a.node}-${a.startsAt}`}>
                    <strong>
                      <Text>{a.name}</Text>
                    </strong>{' '}
                    <span className={a.severity === 'critical' ? 'badge badge-bad' : 'badge badge-warn'}>
                      <Text>{a.severity}</Text>
                    </span>
                    <div className="card-sub">
                      <Text>{a.node || '全局'}</Text>，开始于 {formatTime(Date.parse(a.startsAt))}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      )}
    </>
  );
}
