// 运维接口的统一响应（PRD-ops 3.2 节）和数据类型。
export interface Envelope<T> {
  data: T;
  partial: boolean;
  missingNodes: string[];
  dataTime: number;
}

/** 数据源不可用：卡片要显示"数据不可用"和原因，绝不当成 0。 */
export interface Unavailable {
  unavailable: true;
  reason: string;
}

export function isUnavailable(v: unknown): v is Unavailable {
  return !!v && typeof v === 'object' && (v as Unavailable).unavailable === true;
}

export interface VersionsView {
  list: string[];
  mismatch: boolean;
  mismatchSince?: number;
  over30Min: boolean;
}

export interface NodeView {
  nodeId: string;
  addr: string;
  status: 'ready' | 'draining' | 'notReady' | 'unreachable' | 'identityFailed';
  lastSeenAt: number;
  version: string;
  startedAt: number;
  ready: boolean;
  draining: boolean;
  connections: Record<string, number> | null;
  totalConns: number;
  liveBytes: number;
  heapBytes: number;
  stackBytes: number;
  goMemLimit: number;
  goroutines: number;
  disconnectBufferFrom: number;
}

export interface CodeCount {
  code: string;
  count: number;
}

export interface Alert {
  name: string;
  severity: string;
  node: string;
  startsAt: string;
  summary: string;
}

export interface Overview {
  status: 'ok' | 'degraded' | 'down';
  versions: VersionsView;
  nodes: { ready: number; total: number };
  connections: { total: number; byPlatform: Record<string, number> };
  messages: { perSecond: number; today: number } | Unavailable;
  errors: { share5xx: number; share4xx: number; total: number; top: CodeCount[] } | Unavailable;
  disconnects: { handshake: CodeCount[]; sessionTop3: CodeCount[] } | Unavailable;
  alerts: { list: Alert[] } | Unavailable;
  backup: { sources: { source: string; lastSuccessAt: number; overdue: boolean }[] } | Unavailable;
}

export interface OpsConn {
  connId: string;
  platform: string;
  connectedAt: number;
  node: string;
  ip: string;
  queueLen: number;
}

export interface OpsDisconnect {
  connId: string;
  phase: 'handshake' | 'session';
  platform: string;
  code: number;
  reason: string;
  by: string;
  ts: number;
  durationMs: number;
  ip: string;
  node: string;
}

export interface TroubleshootResult {
  verdict: 'online' | 'onlinePartial' | 'offline' | 'unknown';
  connections: OpsConn[];
  disconnects: OpsDisconnect[];
  summary: { codes: { code: number; count: number }[]; serverClosedMajority: boolean; handshakeAuthMajority: boolean };
  unattributed: { counts: Record<string, number> } | Unavailable;
  bufferFrom: Record<string, number>;
  queriedNodes: string[];
  respondedNodes: number;
}

export interface Risk {
  item: string;
  level: 'high' | 'info';
  text: string;
}

export interface ProductionCheck {
  id: string;
  passed: boolean;
  applicable: boolean;
  detail: string;
}

export interface NodeConfig {
  nodeId: string;
  config: Record<string, unknown> & { productionChecks?: ProductionCheck[] };
  risks: Risk[];
}

export interface ConfigData {
  nodes: NodeConfig[];
  diff: { item: string; values: Record<string, string> }[];
}

export interface Migration {
  version: number;
  name: string;
  appliedAt: number;
  checksumOk: boolean;
  pending: boolean;
}

export interface NodeDB {
  nodeId: string;
  db: {
    type: string;
    location: string;
    connected: boolean;
    version: number;
    migrations: Migration[];
    pending: Migration[] | null;
  };
}

export interface BackupRecord {
  source: string;
  trigger: string;
  startedAt: number;
  finishedAt: number;
  file: string;
  size: number;
  sha256: string;
  verified: boolean;
  encrypted: boolean;
  uploaded: boolean;
  migrationVersion: number;
  host: string;
  release?: string;
  result: string;
  error?: string;
}

export interface BackupGroup {
  source: string;
  lastSuccessAt: number;
  overdue: boolean;
  records: BackupRecord[];
}
