import { getMeta, setMeta, type DB } from "./db.js";
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
}

export function defaultTimezone(): string {
  try { return process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; } catch { return "UTC"; }
}

export const DEFAULTS = (): Settings => ({
  name: "Homebase", timezone: defaultTimezone(), clock: "auto", weekStart: "sun", publicBaseUrl: "",
  theme: "dark", accent: "#6c8cff", kioskCycleSeconds: 0, metricsDays: 14, logDays: 30, autoBackup: true, backupKeep: 7
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
      case "metricsDays": next.metricsDays = whole(value, 1, 365, "Metrics history"); break;
      case "logDays": next.logDays = whole(value, 1, 730, "Log history"); break;
      case "autoBackup": next.autoBackup = Boolean(value); break;
      case "backupKeep": next.backupKeep = whole(value, 1, 60, "Backups to keep"); break;
      default: throw new ValidationError(`Unknown setting "${key}"`);
    }
  }
  const changed = (Object.keys(next) as Array<keyof Settings>).filter(k => next[k] !== current[k]);
  if (changed.length) setMeta(db, "settings", JSON.stringify(next));
  return { settings: next, changed };
}
