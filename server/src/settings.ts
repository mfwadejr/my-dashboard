import { forgetIdle } from "./auth.js";
import { forgetVerbosity, getMeta, setMeta, type DB } from "./db.js";
import { ValidationError } from "./dashboard.js";

export interface Settings {
  name: string;
  timezone: string;
  clock: "auto" | "12" | "24";
  weekStart: "sun" | "mon";
  publicBaseUrl: string;
  theme: "dark" | "light" | "glass" | "auto";
  accent: string;
  kioskCycleSeconds: number;
  metricsDays: number;
  logDays: number;
  autoBackup: boolean;
  backupKeep: number;
  backupEvery: "6h" | "daily" | "weekly";
  backupTime: string;
  backupDay: number;
  /** Graph history: every reading for this many days, then hourly averages, then daily averages up to metricsDays. */
  historyDetailDays: number;
  historyHourlyDays: number;
  logWarnDays: number;
  logErrorDays: number;
  /** Size cap for the log in megabytes (0 = no cap). Oldest lines go first. */
  logMaxMB: number;
  /** Per-area retention in days, overriding the severity rules, e.g. { security: 365 }. */
  logAreaDays: Record<string, number>;
  logExportBeforePrune: boolean;
  logVerbosity: "quiet" | "normal" | "detailed";
  /** Minutes without activity before an admin is signed out (0 = never). */
  idleMinutes: number;
  maintenance: "weekly" | "monthly" | "off";
  updateCheck: boolean;
  /** How much of the icon libraries is kept on this server, and whether an administrator has looked at that choice yet. */
  iconTier: "search" | "cached" | "mirror-single" | "mirror-full";
  iconReviewed: boolean;
}

export const LOG_SOURCES = ["security", "settings", "connection", "camera", "share", "backup", "system", "api"] as const;

export function defaultTimezone(): string {
  try { return process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; } catch { return "UTC"; }
}

export const DEFAULTS = (): Settings => ({
  name: "Homebase", timezone: defaultTimezone(), clock: "auto", weekStart: "sun", publicBaseUrl: "",
  theme: "dark", accent: "#6c8cff", kioskCycleSeconds: 0, metricsDays: 365, logDays: 30, autoBackup: true, backupKeep: 7,
  backupEvery: "daily", backupTime: "02:00", backupDay: 0,
  historyDetailDays: 2, historyHourlyDays: 30, logWarnDays: 90, logErrorDays: 365, logMaxMB: 100, logAreaDays: {}, logExportBeforePrune: false,
  logVerbosity: "normal", idleMinutes: 0, maintenance: "weekly", updateCheck: false, iconTier: "cached", iconReviewed: false
});

export function validTimezone(tz: string): boolean {
  try { new Intl.DateTimeFormat("en", { timeZone: tz }); return true; } catch { return false; }
}

export function getSettings(db: DB): Settings {
  let saved: Partial<Settings> = {};
  try { saved = JSON.parse(getMeta(db, "settings") ?? "{}"); } catch { /* fall back to defaults */ }
  const merged = { ...DEFAULTS(), ...saved };
  if (!validTimezone(merged.timezone)) merged.timezone = defaultTimezone();
  return merged;
}

const oneOf = <T extends string>(value: unknown, list: readonly T[], field: string): T => {
  if (typeof value === "string" && (list as readonly string[]).includes(value)) return value as T;
  throw new ValidationError(`${field} is not one of: ${list.join(", ")}`);
};
const whole = (value: unknown, min: number, max: number, field: string): number => {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw new ValidationError(`${field} must be a whole number from ${min} to ${max}`);
  return n;
};

/** Validates only the fields that were sent; returns the full settings and the names of the fields that changed. */
export function updateSettings(db: DB, input: Record<string, unknown>): { settings: Settings; changed: string[] } {
  const current = getSettings(db);
  const next: Settings = { ...current };
  for (const key of Object.keys(input)) {
    const value = input[key];
    switch (key) {
      case "name": { const t = String(value ?? "").trim(); if (!t || t.length > 40) throw new ValidationError("The dashboard name must be 1 to 40 characters"); next.name = t; break; }
      case "timezone": { const t = String(value ?? "").trim(); if (!validTimezone(t)) throw new ValidationError("That time zone is not recognised (use a name like America/Chicago)"); next.timezone = t; break; }
      case "clock": next.clock = oneOf(value, ["auto", "12", "24"], "Clock format"); break;
      case "weekStart": next.weekStart = oneOf(value, ["sun", "mon"], "Week start"); break;
      case "theme": next.theme = oneOf(value, ["dark", "light", "glass", "auto"], "Theme"); break;
      case "accent": { const t = String(value ?? ""); if (!/^#[0-9a-fA-F]{6}$/.test(t)) throw new ValidationError("The accent colour must look like #6c8cff"); next.accent = t.toLowerCase(); break; }
      case "publicBaseUrl": {
        const t = String(value ?? "").trim().replace(/\/+$/, "");
        if (t && !/^https?:\/\/[^\s/?#]+(\/[^\s?#]*)?$/i.test(t)) throw new ValidationError("The public address must start with http:// or https://");
        next.publicBaseUrl = t; break;
      }
      case "kioskCycleSeconds": { const n = Number(value); next.kioskCycleSeconds = n === 0 ? 0 : whole(n, 5, 3600, "Page cycling"); break; }
      case "metricsDays": next.metricsDays = whole(value, 1, 3650, "Graph history"); break;
      case "historyDetailDays": next.historyDetailDays = whole(value, 1, 30, "Detailed history"); break;
      case "historyHourlyDays": next.historyHourlyDays = whole(value, 2, 365, "Hourly history"); break;
      case "logDays": next.logDays = whole(value, 1, 3650, "Log history"); break;
      case "logWarnDays": next.logWarnDays = whole(value, 1, 3650, "Warning history"); break;
      case "logErrorDays": next.logErrorDays = whole(value, 1, 3650, "Error history"); break;
      case "logMaxMB": next.logMaxMB = value === 0 || value === "0" ? 0 : whole(value, 5, 5000, "Log size limit"); break;
      case "logAreaDays": {
        if (!value || typeof value !== "object" || Array.isArray(value)) throw new ValidationError("Per-area retention must be a list of areas and days");
        const out: Record<string, number> = {};
        for (const [area, days] of Object.entries(value as Record<string, unknown>)) {
          if (!(LOG_SOURCES as readonly string[]).includes(area)) throw new ValidationError(`"${area.slice(0, 30)}" is not a log area`);
          if (days === null || days === 0 || days === "") continue;
          out[area] = whole(days, 1, 3650, `Days for ${area}`);
        }
        next.logAreaDays = out; break;
      }
      case "logExportBeforePrune": next.logExportBeforePrune = Boolean(value); break;
      case "logVerbosity": next.logVerbosity = oneOf(value, ["quiet", "normal", "detailed"], "Log detail"); break;
      case "idleMinutes": { const n = Number(value); next.idleMinutes = n === 0 ? 0 : whole(n, 5, 1440, "Idle sign-out"); break; }
      case "maintenance": next.maintenance = oneOf(value, ["weekly", "monthly", "off"], "Maintenance"); break;
      case "updateCheck": next.updateCheck = Boolean(value); break;
      case "iconTier": next.iconTier = oneOf(value, ["search", "cached", "mirror-single", "mirror-full"] as const, "Icon library storage"); break;
      case "iconReviewed": next.iconReviewed = Boolean(value); break;
      case "autoBackup": next.autoBackup = Boolean(value); break;
      case "backupKeep": next.backupKeep = whole(value, 1, 120, "Backups to keep"); break;
      case "backupEvery": next.backupEvery = oneOf(value, ["6h", "daily", "weekly"], "Backup schedule"); break;
      case "backupTime": { const t = String(value ?? ""); if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(t)) throw new ValidationError("The backup time must look like 02:30"); next.backupTime = t; break; }
      case "backupDay": next.backupDay = whole(value, 0, 6, "Backup day"); break;
      default: throw new ValidationError(`Unknown setting "${key}"`);
    }
  }
  if ("iconTier" in input && !("iconReviewed" in input)) next.iconReviewed = true;
  const touchedHistory = ["historyDetailDays", "historyHourlyDays", "metricsDays"].some(k => k in input);
  if (touchedHistory && next.historyDetailDays >= next.historyHourlyDays) throw new ValidationError("Hourly history must be kept longer than detailed history");
  if (touchedHistory && next.historyHourlyDays >= next.metricsDays) throw new ValidationError("Daily history must be kept longer than hourly history");
  const changed = (Object.keys(next) as Array<keyof Settings>).filter(k => JSON.stringify(next[k]) !== JSON.stringify(current[k]));
  if (changed.length) { setMeta(db, "settings", JSON.stringify(next)); forgetVerbosity(); forgetIdle(); }
  return { settings: next, changed };
}
