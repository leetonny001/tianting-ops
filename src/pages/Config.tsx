import type { ConfigData, NodeConfig, ProductionCheck } from '../api/ops';
import { PageError, PartialBanner, RefreshTools, useOpsData } from '../components/Common';
import { Badge, Text } from '../components/ui';

const groupNames: Record<string, string> = {
  env: '环境',
  keys: '密钥',
  network: '网络',
  limits: '限流与上限',
  database: '数据库',
  switches: '开关',
};
const groupOrder = ['env', 'keys', 'network', 'limits', 'database', 'switches'];

function valueText(v: unknown): string {
  if (Array.isArray(v)) return v.length ? v.join(', ') : '—';
  if (typeof v === 'boolean') return v ? '是' : '否';
  if (v === '' || v === null || v === undefined) return '—';
  return String(v);
}

/** 生产检查项由 im-server 生成，这里不手抄（AC-OPS-10-9）。 */
function Checks({ checks }: { checks: ProductionCheck[] }) {
  return (
    <div className="table-scroll">
      <table>
        <thead>
          <tr>
            <th>检查项</th>
            <th>结论</th>
            <th>实际检查了什么</th>
          </tr>
        </thead>
        <tbody>
          {checks.map((c) => (
            <tr key={c.id}>
              <td className="mono">
                <Text>{c.id}</Text>
              </td>
              <td>
                {!c.applicable ? (
                  '不适用（非生产环境）'
                ) : c.passed ? (
                  <Badge tone="good">通过</Badge>
                ) : (
                  <Badge tone="bad">未通过</Badge>
                )}
              </td>
              <td>
                <Text>{c.detail}</Text>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function NodeSection({ node, diffItems }: { node: NodeConfig; diffItems: Set<string> }) {
  return (
    <section className="panel">
      <h2>
        节点 <Text>{node.nodeId}</Text>
      </h2>
      {node.risks.map((r) => (
        <p key={r.item} className={r.level === 'high' ? 'note note-error' : 'note note-warn'}>
          {r.level === 'high' && <strong>高风险：</strong>}
          <Text>{r.text}</Text>
        </p>
      ))}
      <h3>生产启动保护</h3>
      <Checks checks={node.config.productionChecks ?? []} />
      {groupOrder.map((g) => {
        const values = node.config[g] as Record<string, unknown> | undefined;
        if (!values) return null;
        return (
          <div key={g} className="config-group">
            <h3>{groupNames[g]}</h3>
            <dl className="kv">
              {Object.entries(values).map(([k, v]) => (
                <div key={k} className={diffItems.has(`${g}.${k}`) ? 'kv-row diff-cell' : 'kv-row'}>
                  <dt className="mono">
                    <Text>{k}</Text>
                  </dt>
                  <dd>
                    <Text>{valueText(v)}</Text>
                  </dd>
                </div>
              ))}
            </dl>
          </div>
        );
      })}
    </section>
  );
}

/** 只读，没有修改配置的入口。 */
export function ConfigPage() {
  const { env, error, refresh } = useOpsData<ConfigData>('/console/api/ops/v1/config', false);
  const d = env?.data;
  const diffItems = new Set((d?.diff ?? []).map((x) => x.item));
  return (
    <>
      <div className="page-head">
        <h1>配置检查</h1>
        <RefreshTools refresh={refresh} dataTime={env?.dataTime} />
      </div>
      <p className="muted">每次查看写一条审计。密钥只显示 kid、数量和是否达标。</p>
      <PageError error={error} />
      {env && <PartialBanner missing={env.missingNodes} />}
      {d && d.diff.length > 0 && (
        <section className="panel">
          <h2>节点间差异</h2>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>配置项</th>
                  {d.nodes.map((n) => (
                    <th key={n.nodeId}>
                      <Text>{n.nodeId}</Text>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {d.diff.map((x) => (
                  <tr key={x.item}>
                    <td className="mono">
                      <Text>{x.item}</Text>
                    </td>
                    {d.nodes.map((n) => (
                      <td key={n.nodeId} className="diff-cell">
                        <Text>{x.values[n.nodeId] ?? '—'}</Text>
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
      {d?.nodes.map((n) => (
        <NodeSection key={n.nodeId} node={n} diffItems={diffItems} />
      ))}
    </>
  );
}
