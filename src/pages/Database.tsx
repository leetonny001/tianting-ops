import { isUnavailable, type BackupGroup, type NodeDB, type Unavailable } from '../api/ops';
import { PageError, PartialBanner, RefreshTools, UnavailableNote, useOpsData } from '../components/Common';
import { Badge, Empty, Text } from '../components/ui';
import { formatBytes, formatDuration, formatTime } from '../lib/format';

function Database({ node }: { node: NodeDB }) {
  const db = node.db;
  const pending = db.migrations.filter((m) => m.pending);
  return (
    <section className="panel">
      <h2>
        节点 <Text>{node.nodeId}</Text>
      </h2>
      <dl className="kv">
        <dt>类型</dt>
        <dd>
          <Text>{db.type}</Text>
        </dd>
        <dt>位置</dt>
        <dd className="mono">
          <Text>{db.location}</Text>
        </dd>
        <dt>连通性</dt>
        <dd>{db.connected ? <Badge tone="good">可用</Badge> : <Badge tone="bad">不可用</Badge>}</dd>
        <dt>迁移版本</dt>
        <dd>{db.version}</dd>
      </dl>
      {pending.length > 0 && (
        <p className="note note-warn">
          有 {pending.length} 个迁移未执行，生产环境由发布流程执行 im-server migrate up（执行前自动备份）
        </p>
      )}
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>版本</th>
              <th>名称</th>
              <th>执行时间</th>
              <th>校验和</th>
            </tr>
          </thead>
          <tbody>
            {db.migrations.map((m) => (
              <tr key={m.version} className={m.pending ? 'row-pending' : !m.checksumOk ? 'row-bad' : undefined}>
                <td>{m.version}</td>
                <td>
                  <Text>{m.name}</Text>
                </td>
                <td className="nowrap">{m.pending ? '未执行' : formatTime(m.appliedAt)}</td>
                <td>{m.pending ? '—' : m.checksumOk ? '一致' : <Badge tone="bad">校验和不一致</Badge>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

const yes = (v: boolean) => (v ? '是' : '否');

function Backups({ group, now }: { group: BackupGroup; now: number }) {
  return (
    <section className="panel">
      <h2>
        <Text>
          {group.source === 'im' ? 'im-server' : group.source === 'console' ? 'console-server' : group.source}
        </Text>
      </h2>
      <p className={group.overdue ? 'note note-error' : 'note note-ok'}>
        最近一次成功：
        {group.lastSuccessAt
          ? `${formatTime(group.lastSuccessAt)}（${formatDuration(now - group.lastSuccessAt)}前）`
          : '没有成功记录'}
        {group.overdue && '，超过 2 小时'}
      </p>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>完成时间</th>
              <th>触发</th>
              <th>文件</th>
              <th>大小</th>
              <th>已校验</th>
              <th>已加密</th>
              <th>已上传</th>
              <th>结果</th>
            </tr>
          </thead>
          <tbody>
            {group.records.map((r) => (
              <tr key={`${r.finishedAt}-${r.file}`}>
                <td className="nowrap">{formatTime(r.finishedAt)}</td>
                <td>
                  {r.trigger === 'pre-migrate' ? (
                    <>
                      发布前
                      {r.release && (
                        <>
                          {' '}
                          <Text>{r.release}</Text>
                        </>
                      )}
                    </>
                  ) : (
                    '定时'
                  )}
                </td>
                <td className="mono">
                  <Text>{r.file}</Text>
                </td>
                <td>{formatBytes(r.size)}</td>
                <td>{yes(r.verified)}</td>
                <td>{yes(r.encrypted)}</td>
                <td>{yes(r.uploaded)}</td>
                <td>
                  {r.result === 'success' ? (
                    <Badge tone="good">成功</Badge>
                  ) : (
                    <>
                      <Badge tone="bad">失败</Badge> <Text>{r.error}</Text>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/** 只读：没有执行迁移、备份、恢复、下载的入口。 */
export function DatabasePage() {
  const db = useOpsData<{ nodes: NodeDB[] }>('/console/api/ops/v1/db', false);
  const backups = useOpsData<{ groups: BackupGroup[] } | Unavailable>('/console/api/ops/v1/backups', false);
  const bd = backups.env?.data;
  return (
    <>
      <div className="page-head">
        <h1>数据库与备份</h1>
        <RefreshTools
          refresh={() => {
            void db.refresh();
            void backups.refresh();
          }}
          dataTime={db.env?.dataTime}
        />
      </div>
      <PageError error={db.error} />
      {db.env && <PartialBanner missing={db.env.missingNodes} />}
      <h2>数据库与迁移</h2>
      {db.env?.data.nodes.map((n) => (
        <Database key={n.nodeId} node={n} />
      ))}
      <h2>备份记录</h2>
      <PageError error={backups.error} />
      {bd && isUnavailable(bd) && (
        <div className="panel">
          <UnavailableNote card={bd} />
        </div>
      )}
      {bd && !isUnavailable(bd) && bd.groups.length === 0 && <Empty>还没有备份记录</Empty>}
      {bd &&
        !isUnavailable(bd) &&
        bd.groups.map((g) => <Backups key={g.source} group={g} now={backups.env?.dataTime ?? 0} />)}
    </>
  );
}
