import { useEffect, useState, type ReactNode } from 'react';
import { Link, NavLink, useLocation, useNavigate } from 'react-router';
import { api, ApiError } from '../api/client';
import { errorText } from '../api/errors';
import { roleNames } from '../lib/format';
import { usePolling } from '../lib/hooks';
import { useSession } from '../session';
import { Text } from './ui';

const menu: { to: string; label: string; perm: string; end?: boolean }[] = [
  { to: '/', label: '总览', perm: 'ops.overview.read', end: true },
  { to: '/nodes', label: '节点', perm: 'ops.overview.read' },
  { to: '/troubleshoot', label: '连接排查', perm: 'ops.troubleshoot' },
  { to: '/config', label: '配置检查', perm: 'ops.config.read' },
  { to: '/database', label: '数据库与备份', perm: 'ops.config.read' },
  { to: '/audit', label: '审计日志', perm: 'ops.audit.read' },
  { to: '/accounts', label: '账号管理', perm: 'ops.account.manage' },
];

export const NOTIFICATIONS_READ = 'tt-notifications-read';

function Bell() {
  const [unread, setUnread] = useState(0);
  usePolling(() => {
    api<{ unread: number }>('GET', '/console/api/notifications/unread-count', undefined, { background: true })
      .then((r) => setUnread(r.unread))
      .catch(() => undefined);
  }, 30_000);
  useEffect(() => {
    const clear = () => setUnread(0);
    window.addEventListener(NOTIFICATIONS_READ, clear);
    return () => window.removeEventListener(NOTIFICATIONS_READ, clear);
  }, []);
  return (
    <Link to="/notifications" className="bell" aria-label={`通知，${unread} 条未读`}>
      通知
      {unread > 0 && <span className="bell-count">{unread}</span>}
    </Link>
  );
}

/** 进入 Grafana：签发一次性票据后跳转（CS-117）。403 时显示无权限，不跳转。 */
export async function openGrafana(path = ''): Promise<void> {
  const r = await api<{ data: { url: string } }>('POST', '/console/api/ops/v1/grafana/ticket', {});
  window.location.assign(r.data.url + (path ? `&to=${encodeURIComponent(path)}` : ''));
}

function MetricsLink() {
  const [error, setError] = useState('');
  return (
    <>
      <button
        type="button"
        className="metrics-link"
        onClick={() => {
          setError('');
          openGrafana().catch((err) =>
            setError(err instanceof ApiError && err.code === 4030 ? '无权限' : errorText(err)),
          );
        }}
      >
        指标
      </button>
      {error && (
        <span className="side-error" role="alert">
          {error}
        </span>
      )}
    </>
  );
}

export function Layout({ children }: { children: ReactNode }) {
  const { session, can, setSession, reload } = useSession();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  // 每次切换页面都确认一次会话：被挤掉、角色变了，点菜单就能知道。
  useEffect(() => {
    reload().catch(() => undefined);
  }, [pathname, reload]);
  if (!session) return null;
  const logout = async () => {
    await api('POST', '/console/api/auth/logout', {}).catch(() => undefined);
    setSession(null);
    navigate('/login', { replace: true });
  };
  const left = session.recoveryCodesLeft;
  return (
    <div className="shell">
      <nav className="side" aria-label="主菜单">
        <div className="brand">天听运维后台</div>
        <ul>
          {menu
            .filter((m) => can(m.perm))
            .map((m) => (
              <li key={m.to}>
                <NavLink to={m.to} end={m.end}>
                  {m.label}
                </NavLink>
              </li>
            ))}
          {can('ops.overview.read') && (
            <li>
              <MetricsLink />
            </li>
          )}
        </ul>
      </nav>
      <div className="main">
        <header className="top">
          {left !== undefined && left <= 2 && (
            <Link to="/settings" className="top-warn">
              恢复码只剩 {left} 个，去重新生成
            </Link>
          )}
          <div className="top-right">
            <Bell />
            <Link to="/settings" className="top-user">
              <Text>{session.account.displayName || session.account.username}</Text>
            </Link>
            <span className="top-roles">{session.roles.map((r) => roleNames[r] ?? r).join('、')}</span>
            <button type="button" className="btn btn-small" onClick={logout}>
              退出
            </button>
          </div>
        </header>
        <main className="content">{children}</main>
      </div>
    </div>
  );
}
