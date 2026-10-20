export interface Tile { id: string; type: string; w: number; h: number; x?: number; y?: number; config: Record<string, any> }
export interface Group { id: string; name: string; layout: string; collapsed: boolean; pack?: boolean; tiles: Tile[] }
export interface Tab { id: string; name: string; emoji: string; icon?: string; iconRef?: string; groups: Group[] }
export interface Dashboard { revision: number; tabs: Tab[] }

export interface Snapshot { id: string; ok: boolean; ts: number | null; checkedAt: number; error: string | null; data: any }
export interface IntegrationInfo { id: string; type: string; name: string; enabled: boolean; url?: string; intervalSeconds?: number; hasKey?: boolean; insecureTls?: boolean; icon?: string; iconRef?: string; openUrl?: string; openMode?: "tab" | "inapp"; fields?: Array<{ path: string; label: string; unit: string }> }
export interface IntegrationType { id: string; name: string; description: string; urlHint: string; keyLabel: string; hasCatalog?: boolean }
export interface CameraInfo { id: string; name: string; icon?: string; iconRef?: string }
export interface IconHit { ref: string; label: string; source: string; sourceName: string; preview: string }
export interface IconChoice { icon: string; iconRef: string }
export interface IconSourceStatus { id: string; name: string; status: "idle" | "queued" | "running" | "error"; error: string | null; indexAt: number | null; mirrorAt: number | null; progress: number; indexed: number; mirrored: number; removed: number }
export interface IconStatus { reviewed: boolean; tier: IconTier; ready: boolean; sizes: { mirror: number; cache: number; used: number }; updates: number; sources: IconSourceStatus[] }
export type IconTier = "search" | "cached" | "mirror-single" | "mirror-full"

export interface AuthUser { id: string; username: string; role: "admin" | "viewer"; totp?: boolean; icon?: string; iconRef?: string }
export interface SettingsDoc {
  name: string; timezone: string; clock: "auto" | "12" | "24"; weekStart: "sun" | "mon"; publicBaseUrl: string;
  theme: "dark" | "light" | "glass" | "auto"; accent: string; kioskCycleSeconds: number;
  metricsDays: number; logDays: number; autoBackup: boolean; backupKeep: number;
  backupEvery: "6h" | "daily" | "weekly"; backupTime: string; backupDay: number;
  historyDetailDays: number; historyHourlyDays: number; logWarnDays: number; logErrorDays: number; logMaxMB: number; logAreaDays: Record<string, number>;
  logExportBeforePrune: boolean; logVerbosity: "quiet" | "normal" | "detailed"; idleMinutes: number; maintenance: "weekly" | "monthly" | "off"; updateCheck: boolean; iconTier: IconTier; iconReviewed: boolean;
}
export interface AboutInfo { version: string; commit: string; built: string | null; node: string; build: string; startedAt: number; publicPort: number | null; go2rtc: boolean }

export interface VerifyCheck { id: string; label: string; status: "pass" | "warn" | "fail"; detail: string }
export interface VerifyReport { kind: "database" | "json" | "complete"; ok: boolean; restorable: boolean; checks: VerifyCheck[]; counts: Record<string, number>; size: number; createdAt: number | null; layout: number | null; summary: string }

export type MonitorState = "up" | "down" | "pending" | "paused" | "maintenance" | "unknown";
export type MonitorKind = "http" | "keyword" | "json" | "tcp" | "ping" | "dns" | "cert" | "push" | "docker" | "postgres" | "mysql" | "mongodb" | "redis" | "mssql" | "group";
export interface MonitorConfigInfo {
  id: string; name: string; group: string; description: string; kind: MonitorKind; target: string; port: number; keyword: string; invert: boolean; jsonPath: string; expect: string;
  method: string; body: string; headers: string; authUser: string; hasAuthPass: boolean; hasConn: boolean; parentId: string; maxRedirects: number; upsideDown: boolean; dnsType: string; dnsServer: string;
  intervalSeconds: number; retryIntervalSeconds: number; timeoutSeconds: number; retries: number; insecureTls: boolean; certWarnDays: number; enabled: boolean; position: number;
}
export interface MonitorInfo {
  id: string; name: string; group: string; parentId: string; description: string; kind: MonitorKind; enabled: boolean; state: MonitorState; since: number | null; lastAt: number | null; lastMs: number | null; message: string;
  uptime24h: number | null; uptime7d: number | null; uptime30d: number | null; avgMs24h: number | null; certExpires: number | null; strip: Array<0 | 1 | 2 | 3>; config?: MonitorConfigInfo;
}
export interface MonitorHistory {
  hours: number; points: Array<{ t: number; ms: number | null; down: boolean }>; days: DayBar[]; recent: Array<{ ts: number; s: number; ms: number | null; msg: string }>;
  events: Array<{ ts: number; up: boolean; msg: string }>; uptimes: { d1: number | null; d7: number | null; d30: number | null; d90: number | null; d365: number | null };
}
export interface MaintenanceWindow {
  id: string; title: string; monitors: string[]; kind: "once" | "daily" | "weekly"; startsAt: number | null; endsAt: number | null; days: number[]; startTime: string; durationMin: number; enabled: boolean;
}
export interface DayBar { day: number; up: number; down: number }
export interface StatusPageInfo { id: string; title: string; message: string; tone: "info" | "warn" | "bad"; domain: string; monitors: string[]; enabled: boolean; views: number; lastUsed: number | null; createdAt: number; token: string; path: string }
export interface IncidentPost { id: string; pageId: string; title: string; body: string; style: "info" | "warn" | "bad" | "ok"; pinned: boolean; resolvedAt: number | null; createdAt: number; updatedAt: number }
export interface PublicIncident { id: string; title: string; body: string; style: "info" | "warn" | "bad" | "ok"; pinned: boolean; resolved: boolean; createdAt: number; updatedAt: number }
export interface PublicMaintenance { title: string; active: boolean; kind: "once" | "daily" | "weekly"; startsAt: number | null; endsAt: number | null; days: number[]; startTime: string; durationMin: number }
export interface PublicStatus {
  title: string; message: string; tone: "info" | "warn" | "bad"; overall: "up" | "degraded" | "down" | "maintenance" | "unknown"; updatedAt: number; timezone: string; incidents: PublicIncident[]; maintenance: PublicMaintenance[];
  monitors: Array<{ name: string; group: string; state: MonitorState; uptime24h: number | null; uptime30d: number | null; ms: number | null; days: DayBar[] }>;
}

export type RackKind = "generic" | "switch" | "patch" | "router" | "server" | "nas" | "pdu" | "ups" | "shelf" | "blank" | "cable";
export type RackFace = "front" | "rear" | "both";
export interface RackDeviceInfo {
  id: string; rackId: string; name: string; kind: RackKind; units: number; slot: number; face: RackFace; width: 19 | 10; color: string; ports: number; watts: number | null;
  integrationId: string; notes: string; icon: string; iconRef: string; rearIcon: string; rearIconRef: string; fit: "stretch" | "fit" | "fill"; look: "drawn" | "image";
}
export interface RackInfo { id: string; name: string; units: number; width: 19 | 10; topDown: boolean; notes: string; position: number; devices: RackDeviceInfo[] }
