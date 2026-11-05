import type { ReactNode } from 'react';
import { Navigate, Route, Routes } from 'react-router';
import { Layout } from './components/Layout';
import { AccountsPage } from './pages/Accounts';
import { ActivatePage, LoginPage, SetupPage } from './pages/Auth';
import { AuditPage } from './pages/Audit';
import { ConfigPage } from './pages/Config';
import { DatabasePage } from './pages/Database';
import { NoPermissionPage } from './pages/NoPermission';
import { NodesPage } from './pages/Nodes';
import { NotificationsPage } from './pages/Notifications';
import { OverviewPage } from './pages/Overview';
import { SettingsPage } from './pages/Settings';
import { SilencesPage } from './pages/Silences';
import { TroubleshootPage } from './pages/Troubleshoot';
import { useSession } from './session';

/** 路由守卫：权限只是界面提示，真正的判断在 console-server。 */
function Guard({ perm, children }: { perm?: string; children: ReactNode }) {
  const { session, can, signedOutReason } = useSession();
  if (session === undefined) return <p className="loading">加载中…</p>;
  if (session === null) {
    return (
      <Navigate to={signedOutReason ? `/login?reason=${encodeURIComponent(signedOutReason)}` : '/login'} replace />
    );
  }
  if (session.state === 'setup') return <Navigate to="/setup" replace />;
  return <Layout>{perm && !can(perm) ? <NoPermissionPage /> : children}</Layout>;
}

/** 首页：审计员和运维超管看不了总览，直接到他们的页面。 */
function Home() {
  const { can } = useSession();
  if (can('ops.overview.read')) return <OverviewPage />;
  if (can('ops.audit.read')) return <Navigate to="/audit" replace />;
  if (can('ops.account.manage')) return <Navigate to="/accounts" replace />;
  return <NoPermissionPage />;
}

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/activate" element={<ActivatePage />} />
      <Route path="/setup" element={<SetupPage />} />
      <Route
        path="/"
        element={
          <Guard>
            <Home />
          </Guard>
        }
      />
      <Route
        path="/nodes"
        element={
          <Guard perm="ops.overview.read">
            <NodesPage />
          </Guard>
        }
      />
      <Route
        path="/troubleshoot"
        element={
          <Guard perm="ops.troubleshoot">
            <TroubleshootPage />
          </Guard>
        }
      />
      <Route
        path="/silences"
        element={
          <Guard perm="ops.silence.write">
            <SilencesPage />
          </Guard>
        }
      />
      <Route
        path="/config"
        element={
          <Guard perm="ops.config.read">
            <ConfigPage />
          </Guard>
        }
      />
      <Route
        path="/database"
        element={
          <Guard perm="ops.config.read">
            <DatabasePage />
          </Guard>
        }
      />
      <Route
        path="/audit"
        element={
          <Guard perm="ops.audit.read">
            <AuditPage />
          </Guard>
        }
      />
      <Route
        path="/accounts"
        element={
          <Guard perm="ops.account.manage">
            <AccountsPage />
          </Guard>
        }
      />
      <Route
        path="/notifications"
        element={
          <Guard>
            <NotificationsPage />
          </Guard>
        }
      />
      <Route
        path="/settings"
        element={
          <Guard>
            <SettingsPage />
          </Guard>
        }
      />
      <Route
        path="*"
        element={
          <Guard>
            <NoPermissionPage notFound />
          </Guard>
        }
      />
    </Routes>
  );
}
