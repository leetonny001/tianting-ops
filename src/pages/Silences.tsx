import { useEffect, useState, type FormEvent } from 'react';
import { api } from '../api/client';
import { isUnavailable, type AlertsCard, type Envelope, type NodeView, type Silence } from '../api/ops';
import { PageError, RefreshTools, UnavailableNote, useOpsData } from '../components/Common';
import { Empty, ErrorNote, Field, Modal, Text } from '../components/ui';
import { alertNamePattern, formatTime, idPattern, matcherText, reasonValid, ticketPattern } from '../lib/format';

const MIN_MINUTES = 15;
const MAX_MINUTES = 24 * 60;

/** PRD-ops F-OPS-07 的告警规则。输入框的候选项，其他名字也能填（新加的规则），最终以服务端校验为准。 */
const KNOWN_ALERTS = [
  '节点不可达',
  '无就绪节点',
  '5xxx错误率高',
  '命令耗时高',
  '在线连接骤降',
  '慢连接增多',
  '握手异常',
  '内存逼近上限',
  '疑似GC风暴',
  '备份过期',
  '版本不一致',
];

/** 创建静默。只有告警名和节点两个等值条件：界面上没有正则，也发不出别的标签（F-OPS-18 规则 2）。 */
function CreateForm({ onCreated }: { onCreated: () => void }) {
  const [alertname, setAlertname] = useState('');
  const [nodeId, setNodeId] = useState('');
  const [minutes, setMinutes] = useState('60');
  const [ticket, setTicket] = useState('');
  const [reason, setReason] = useState('');
  const [nodes, setNodes] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    api<Envelope<{ nodes: NodeView[] }>>('GET', '/console/api/ops/v1/nodes')
      .then((e) => setNodes(e.data.nodes.map((n) => n.nodeId)))
      .catch(() => undefined); // 只是候选项，取不到也能手填
  }, []);
  const name = alertname.trim();
  const node = nodeId.trim();
  const duration = Number(minutes);
  const nameBad = name !== '' && !alertNamePattern.test(name);
  const nodeBad = node !== '' && !idPattern.test(node);
  const durationBad = !Number.isInteger(duration) || duration < MIN_MINUTES || duration > MAX_MINUTES;
  const ticketBad = ticket.trim() !== '' && !ticketPattern.test(ticket.trim());
  const reasonBad = reason !== '' && !reasonValid(reason);
  const ok =
    (name !== '' || node !== '') &&
    !nameBad &&
    !nodeBad &&
    !durationBad &&
    ticketPattern.test(ticket.trim()) &&
    reasonValid(reason);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!ok || busy) return;
    setBusy(true);
    setError(null);
    const matchers = [];
    if (name) matchers.push({ name: 'alertname', value: name });
    if (node) matchers.push({ name: 'node_id', value: node });
    try {
      await api('POST', '/console/api/ops/v1/silences', {
        matchers,
        durationMinutes: duration,
        ticket: ticket.trim(),
        reason: reason.trim(),
      });
      setAlertname('');
      setNodeId('');
      setTicket('');
      setReason('');
      onCreated();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="panel filters" onSubmit={submit} aria-label="创建静默">
      <Field
        label="告警名（alertname）"
        hint="精确匹配，不支持正则"
        error={nameBad ? '只能有文字、数字、_、-、.' : null}
      >
        {(id) => (
          <>
            <input
              id={id}
              list="silence-alerts"
              value={alertname}
              onChange={(e) => setAlertname(e.target.value)}
              autoComplete="off"
            />
            <datalist id="silence-alerts">
              {KNOWN_ALERTS.map((a) => (
                <option key={a} value={a} />
              ))}
            </datalist>
          </>
        )}
      </Field>
      <Field label="节点（node_id）" hint="和告警名至少填一个" error={nodeBad ? '节点 ID 格式不正确' : null}>
        {(id) => (
          <>
            <input
              id={id}
              list="silence-nodes"
              value={nodeId}
              onChange={(e) => setNodeId(e.target.value)}
              autoComplete="off"
            />
            <datalist id="silence-nodes">
              {nodes.map((n) => (
                <option key={n} value={n} />
              ))}
            </datalist>
          </>
        )}
      </Field>
      <Field
        label="时长（分钟）"
        hint="15 分钟～24 小时（1440 分钟）"
        error={minutes !== '' && durationBad ? '时长需要在 15 到 1440 分钟之间' : null}
      >
        {(id) => (
          <input
            id={id}
            type="number"
            min={MIN_MINUTES}
            max={MAX_MINUTES}
            step={1}
            value={minutes}
            onChange={(e) => setMinutes(e.target.value)}
          />
        )}
      </Field>
      <Field label="工单号" error={ticketBad ? '工单号是 3～32 位字母、数字、_、-' : null}>
        {(id) => <input id={id} value={ticket} onChange={(e) => setTicket(e.target.value)} autoComplete="off" />}
      </Field>
      <Field label="理由" error={reasonBad ? '理由需要 4～200 个字符，不能由同一个字符重复组成' : null}>
        {(id) => <input id={id} value={reason} onChange={(e) => setReason(e.target.value)} autoComplete="off" />}
      </Field>
      <div className="filters-submit">
        <button className="btn btn-primary" type="submit" disabled={!ok || busy}>
          {busy ? '创建中…' : '创建静默'}
        </button>
      </div>
      <ErrorNote error={error} />
    </form>
  );
}

function ExpireDialog({ silence, onClose, onDone }: { silence: Silence; onClose: () => void; onDone: () => void }) {
  const [ticket, setTicket] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const ticketOk = ticketPattern.test(ticket.trim());
  const reasonOk = reasonValid(reason);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!ticketOk || !reasonOk || busy) return;
    setBusy(true);
    setError(null);
    try {
      await api('POST', `/console/api/ops/v1/silences/${encodeURIComponent(silence.id)}:expire`, {
        ticket: ticket.trim(),
        reason: reason.trim(),
      });
      onDone();
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  };
  return (
    <Modal title="提前结束静默" onClose={onClose}>
      <form onSubmit={submit}>
        <p className="modal-body">
          结束后 <Text>{silence.matchers.map(matcherText).join('，')}</Text> 的告警会恢复通知。
        </p>
        <Field label="工单号" error={ticket && !ticketOk ? '工单号是 3～32 位字母、数字、_、-' : null}>
          {(id) => (
            <input id={id} value={ticket} onChange={(e) => setTicket(e.target.value)} autoComplete="off" autoFocus />
          )}
        </Field>
        <Field label="理由" error={reason && !reasonOk ? '理由需要 4～200 个字符，不能由同一个字符重复组成' : null}>
          {(id) => <input id={id} value={reason} onChange={(e) => setReason(e.target.value)} autoComplete="off" />}
        </Field>
        <ErrorNote error={error} />
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose}>
            取消
          </button>
          <button className="btn btn-danger" type="submit" disabled={!ticketOk || !reasonOk || busy}>
            {busy ? '处理中…' : '提前结束'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

/** 告警静默（FE-520）。工单号和理由只在请求体里，不进 URL。 */
export function SilencesPage() {
  const { env, error, refresh, paused, setPaused } = useOpsData<AlertsCard>('/console/api/ops/v1/alerts', true);
  const [expiring, setExpiring] = useState<Silence | null>(null);
  const card = env?.data;
  const silences = card && !isUnavailable(card) ? card.silences : undefined;
  return (
    <>
      <div className="page-head">
        <h1>告警静默</h1>
        <RefreshTools refresh={refresh} paused={paused} setPaused={setPaused} dataTime={env?.dataTime} />
      </div>
      <p className="muted">静默只影响告警通知，不影响 IM。创建和提前结束都要重新验证，并写审计。到期后自动恢复通知。</p>
      <CreateForm onCreated={refresh} />
      <PageError error={error} />
      <section className="panel" aria-label="生效中的静默">
        <h2>生效中的静默</h2>
        {card && isUnavailable(card) ? (
          <UnavailableNote card={card} text="告警数据不可用" />
        ) : isUnavailable(silences) ? (
          <UnavailableNote card={silences} text="静默数据不可用" />
        ) : !silences ? null : silences.length === 0 ? (
          <Empty>当前没有生效的静默</Empty>
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>匹配条件</th>
                  <th>创建人</th>
                  <th>开始时间</th>
                  <th>到期时间</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {silences.map((s) => (
                  <tr key={s.id}>
                    <td>
                      <Text>{s.matchers.map(matcherText).join('，')}</Text>
                    </td>
                    <td>
                      <Text>{s.createdBy}</Text>
                    </td>
                    <td className="nowrap">{formatTime(Date.parse(s.startsAt))}</td>
                    <td className="nowrap">{formatTime(Date.parse(s.endsAt))}</td>
                    <td>
                      <button type="button" className="link" onClick={() => setExpiring(s)}>
                        提前结束
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      {expiring && (
        <ExpireDialog
          silence={expiring}
          onClose={() => setExpiring(null)}
          onDone={() => {
            setExpiring(null);
            refresh();
          }}
        />
      )}
    </>
  );
}
