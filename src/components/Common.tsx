import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { api } from '../api/client';
import type { Envelope, Unavailable } from '../api/ops';
import { formatTime } from '../lib/format';
import { usePolling } from '../lib/hooks';
import { ErrorNote, Text } from './ui';

/** 部分结果：页面顶部标出（3.2 节）。 */
export function PartialBanner({ missing }: { missing: string[] }) {
  if (missing.length === 0) return null;
  return (
    <p className="note note-warn" role="status">
      节点 <Text>{missing.join('、')}</Text> 未响应，结果可能不完整
    </p>
  );
}

export function DataTime({ at }: { at?: number }) {
  return <span className="muted">数据时间：{formatTime(at)}</span>;
}

/** 数据不可用：显示原因，不显示 0 或"无"。 */
export function UnavailableNote({ card, text }: { card: Unavailable; text?: string }) {
  return (
    <p className="unavailable">
      {text ?? '数据不可用'}
      <span className="card-sub">
        （<Text>{card.reason}</Text>）
      </span>
    </p>
  );
}

/**
 * 读取运维接口。auto 时每 15 秒自动刷新，可暂停；自动刷新带后台头，不续期空闲计时；页面不可见时停止（FE-501）。
 */
export function useOpsData<T>(path: string, auto: boolean) {
  const [env, setEnv] = useState<Envelope<T> | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [paused, setPaused] = useState(false);
  const load = useCallback(
    (background: boolean) =>
      api<Envelope<T>>('GET', path, undefined, { background })
        .then((e) => {
          setEnv(e);
          setError(null);
        })
        .catch(setError),
    [path],
  );
  const [first, setFirst] = useState(true);
  useEffect(() => {
    if (first) {
      setFirst(false);
      if (!auto) void load(false);
    }
  }, [first, auto, load]);
  usePolling(() => {
    if (auto && !paused) void load(env !== null);
  }, 15_000);
  return { env, error, refresh: () => load(false), paused, setPaused };
}

export function RefreshTools({
  refresh,
  paused,
  setPaused,
  dataTime,
}: {
  refresh: () => void;
  paused?: boolean;
  setPaused?: (v: boolean) => void;
  dataTime?: number;
}) {
  return (
    <div className="page-tools">
      <DataTime at={dataTime} />
      {setPaused && (
        <button type="button" className="btn btn-small" onClick={() => setPaused(!paused)}>
          {paused ? '恢复自动刷新' : '暂停自动刷新'}
        </button>
      )}
      <button type="button" className="btn btn-small" onClick={refresh}>
        刷新
      </button>
    </div>
  );
}

export function PageError({ error }: { error: unknown }): ReactNode {
  return <ErrorNote error={error} />;
}
