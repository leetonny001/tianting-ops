import { useEffect, useState, type FormEvent } from 'react';
import { api } from '../api/client';
import type { AccountRow } from '../api/types';
import { Badge, ConfirmDialog, CopyButton, Empty, ErrorNote, Field, Modal, Text } from '../components/ui';
import { formatTime, roleNames } from '../lib/format';
import { useSession } from '../session';

const ALL_ROLES = ['ops_viewer', 'ops_engineer', 'ops_auditor', 'ops_superadmin'];
/** 互斥角色：不能和任何其他角色叠加（F-OPS-02），界面上不可同时勾选，最终以服务端 4093 为准。 */
const EXCLUSIVE = ['ops_auditor', 'ops_superadmin'];

/** 角色多选。 */
function RolePicker({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) {
  const exclusive = value.find((r) => EXCLUSIVE.includes(r));
  return (
    <fieldset className="roles">
      <legend>角色</legend>
      {ALL_ROLES.map((r) => (
        <label key={r} className="check">
          <input
            type="checkbox"
            checked={value.includes(r)}
            disabled={exclusive ? r !== exclusive : EXCLUSIVE.includes(r) && value.length > 0}
            onChange={(e) => onChange(e.target.checked ? [...value, r] : value.filter((x) => x !== r))}
          />
          {roleNames[r]}
        </label>
      ))}
    </fieldset>
  );
}

/** 授予后不马上生效的角色（F-OPS-02 规则 6）。这里只是提示，以服务端返回的 pendingRoles 为准。 */
const NEEDS_APPROVAL = ['ops_engineer'];

function ApprovalHint({ roles, before = [] }: { roles: string[]; before?: string[] }) {
  if (!roles.some((r) => NEEDS_APPROVAL.includes(r) && !before.includes(r))) return null;
  return <p className="note note-warn">授予排障工程师需要另一名运维超管批准后才生效。</p>;
}

function ActivationCode({
  username,
  code,
  pending,
  onClose,
}: {
  username: string;
  code: string;
  pending?: string[];
  onClose: () => void;
}) {
  return (
    <Modal title="激活码" onClose={onClose}>
      <p className="note note-warn">激活码只显示这一次，24 小时内有效。请用安全的方式发给本人。</p>
      {pending && pending.length > 0 && (
        <p className="note note-warn">
          {pending.map((r) => roleNames[r] ?? r).join('、')}角色待批准：需要另一名运维超管在账号管理里批准后才生效。
        </p>
      )}
      <p>
        账号：<Text>{username}</Text>
      </p>
      <p className="codes-one">
        <code data-testid="activation-code">{code}</code> <CopyButton text={code} />
      </p>
      <div className="modal-actions">
        <button className="btn btn-primary" type="button" onClick={onClose}>
          我已记下
        </button>
      </div>
    </Modal>
  );
}

type Dialog =
  | { kind: 'create' }
  | { kind: 'roles'; account: AccountRow }
  | { kind: 'action'; account: AccountRow; action: 'disable' | 'enable' | 'reset' | 'unlock' }
  | { kind: 'code'; username: string; code: string; pending?: string[] }
  | { kind: 'approve'; account: AccountRow; role: string; requestedBy: string }
  | null;

const actionText = {
  disable: { label: '停用', body: '停用后该账号的全部会话立即失效，不能再登录。', danger: true },
  enable: { label: '启用', body: '启用后账号可以再次登录。', danger: false },
  reset: { label: '重置', body: '重置会清除密码和二次验证，全部会话失效，并生成新的激活码。', danger: true },
  unlock: { label: '解锁', body: '清除登录失败计数，账号可以立即再次尝试登录。', danger: false },
};

function CreateDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (u: string, c: string, pending?: string[]) => void;
}) {
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [roles, setRoles] = useState<string[]>([]);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ activationCode: string; pendingRoles?: string[] }>('POST', '/console/api/accounts', {
        username: username.trim(),
        displayName: displayName.trim(),
        roles,
      });
      onCreated(username.trim(), r.activationCode, r.pendingRoles);
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  };
  return (
    <Modal title="新建账号" onClose={onClose}>
      <form onSubmit={submit}>
        <Field label="账号名" hint="小写字母、数字、. _ -，3～32 位">
          {(id) => (
            <input
              id={id}
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoFocus
              autoComplete="off"
            />
          )}
        </Field>
        <Field label="显示名">
          {(id) => <input id={id} value={displayName} onChange={(e) => setDisplayName(e.target.value)} />}
        </Field>
        <RolePicker value={roles} onChange={setRoles} />
        <ApprovalHint roles={roles} />
        <ErrorNote error={error} />
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose}>
            取消
          </button>
          <button className="btn btn-primary" type="submit" disabled={busy || !username.trim() || roles.length === 0}>
            创建
          </button>
        </div>
      </form>
    </Modal>
  );
}

function RolesDialog({ account, onClose, onDone }: { account: AccountRow; onClose: () => void; onDone: () => void }) {
  // 待批准的角色算在里面：不勾掉就继续等批准，勾掉就撤回。
  const [roles, setRoles] = useState(() => [...account.roles, ...(account.pendingRoles ?? []).map((p) => p.role)]);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await api('POST', `/console/api/accounts/${account.id}/roles`, { roles });
      onDone();
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  };
  return (
    <Modal title={`修改 ${account.username} 的角色`} onClose={onClose}>
      <form onSubmit={submit}>
        <p className="modal-body">角色变化后，该账号需要重新登录。</p>
        <RolePicker value={roles} onChange={setRoles} />
        <ApprovalHint roles={roles} before={account.roles} />
        <ErrorNote error={error} />
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose}>
            取消
          </button>
          <button className="btn btn-primary" type="submit" disabled={busy || roles.length === 0}>
            保存
          </button>
        </div>
      </form>
    </Modal>
  );
}

export function AccountsPage() {
  const { session } = useSession();
  const [list, setList] = useState<AccountRow[]>([]);
  const [error, setError] = useState<unknown>(null);
  const [dialog, setDialog] = useState<Dialog>(null);
  const load = () => {
    api<{ accounts: AccountRow[] }>('GET', '/console/api/accounts?limit=100')
      .then((r) => setList(r.accounts))
      .catch(setError);
  };
  useEffect(load, []);
  const selfId = session?.account.id;
  return (
    <>
      <div className="page-head">
        <h1>账号管理</h1>
        <button className="btn btn-primary" type="button" onClick={() => setDialog({ kind: 'create' })}>
          新建账号
        </button>
      </div>
      <ErrorNote error={error} />
      <table>
        <thead>
          <tr>
            <th>账号</th>
            <th>显示名</th>
            <th>角色</th>
            <th>状态</th>
            <th>激活时间</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          {list.map((a) => (
            <tr key={a.id}>
              <td>
                <Text>{a.username}</Text>
              </td>
              <td>
                <Text>{a.displayName}</Text>
              </td>
              <td>
                {a.roles.map((r) => roleNames[r] ?? r).join('、') || '—'}
                {a.pendingRoles?.map((p) => (
                  <div key={p.role}>
                    <Badge tone="warn">待批准</Badge> {roleNames[p.role] ?? p.role}
                    <div className="muted">
                      <Text>{p.requestedBy}</Text> 发起
                      {p.requestedBy === session?.account.username && '，需要另一名运维超管批准'}
                    </div>
                  </div>
                ))}
              </td>
              <td>
                {a.status === 'active' ? (
                  <Badge tone="good">启用</Badge>
                ) : a.status === 'pending' ? (
                  <Badge>待激活</Badge>
                ) : (
                  <Badge tone="bad">已停用</Badge>
                )}
                {a.locked && <Badge tone="warn">已锁定</Badge>}
              </td>
              <td>{formatTime(a.activatedAt)}</td>
              <td className="actions">
                {/* 谁能批准只由服务端判断：发起人点了会收到 4030，界面不替它决定（FE-521）。 */}
                {a.pendingRoles?.map((p) => (
                  <button
                    key={p.role}
                    type="button"
                    className="link"
                    onClick={() => setDialog({ kind: 'approve', account: a, role: p.role, requestedBy: p.requestedBy })}
                  >
                    批准
                  </button>
                ))}
                {a.id === selfId ? (
                  <span className="muted">自己的账号</span>
                ) : (
                  <>
                    <button type="button" className="link" onClick={() => setDialog({ kind: 'roles', account: a })}>
                      改角色
                    </button>
                    {a.status === 'disabled' ? (
                      <button
                        type="button"
                        className="link"
                        onClick={() => setDialog({ kind: 'action', account: a, action: 'enable' })}
                      >
                        启用
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="link"
                        onClick={() => setDialog({ kind: 'action', account: a, action: 'disable' })}
                      >
                        停用
                      </button>
                    )}
                    <button
                      type="button"
                      className="link"
                      onClick={() => setDialog({ kind: 'action', account: a, action: 'reset' })}
                    >
                      重置
                    </button>
                  </>
                )}
                {a.locked && (
                  <button
                    type="button"
                    className="link"
                    onClick={() => setDialog({ kind: 'action', account: a, action: 'unlock' })}
                  >
                    解锁
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {list.length === 0 && !error && <Empty>还没有账号</Empty>}
      {dialog?.kind === 'create' && (
        <CreateDialog
          onClose={() => setDialog(null)}
          onCreated={(username, code, pending) => {
            setDialog({ kind: 'code', username, code, pending });
            load();
          }}
        />
      )}
      {dialog?.kind === 'roles' && (
        <RolesDialog
          account={dialog.account}
          onClose={() => setDialog(null)}
          onDone={() => {
            setDialog(null);
            load();
          }}
        />
      )}
      {dialog?.kind === 'action' && (
        <ConfirmDialog
          title={`${actionText[dialog.action].label}账号 ${dialog.account.username}`}
          danger={actionText[dialog.action].danger}
          onClose={() => setDialog((d) => (d?.kind === 'code' ? d : null))}
          onConfirm={async () => {
            const { account, action } = dialog;
            const r = await api<{ activationCode?: string }>(
              'POST',
              `/console/api/accounts/${account.id}/${action}`,
              {},
            );
            load();
            if (r.activationCode) setDialog({ kind: 'code', username: account.username, code: r.activationCode });
          }}
        >
          {actionText[dialog.action].body}
        </ConfirmDialog>
      )}
      {dialog?.kind === 'approve' && (
        <ConfirmDialog
          title={`批准 ${dialog.account.username} 的角色`}
          confirmLabel="批准"
          onClose={() => setDialog(null)}
          onConfirm={async () => {
            await api('POST', `/console/api/accounts/${dialog.account.id}/roles/approve`, { role: dialog.role });
            load();
          }}
        >
          <Text>{dialog.requestedBy}</Text> 授予 <Text>{dialog.account.username}</Text> 角色「
          {roleNames[dialog.role] ?? dialog.role}」。批准后马上生效，该账号需要重新登录。
        </ConfirmDialog>
      )}
      {dialog?.kind === 'code' && (
        <ActivationCode
          username={dialog.username}
          code={dialog.code}
          pending={dialog.pending}
          onClose={() => setDialog(null)}
        />
      )}
    </>
  );
}
