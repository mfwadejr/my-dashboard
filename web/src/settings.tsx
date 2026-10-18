import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { api } from "./api";
import type { SettingsDoc } from "./types";

const browserZone = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; } catch { return "UTC"; } })();

export const DEFAULT_SETTINGS: SettingsDoc = {
  name: "Homebase", timezone: browserZone, clock: "auto", weekStart: "sun", publicBaseUrl: "", theme: "dark", accent: "#6c8cff",
  kioskCycleSeconds: 0, metricsDays: 365, logDays: 30, autoBackup: true, backupKeep: 7, backupEvery: "daily", backupTime: "02:00", backupDay: 0,
  historyDetailDays: 2, historyHourlyDays: 30, logWarnDays: 90, logErrorDays: 365, logMaxMB: 100, logAreaDays: {}, logExportBeforePrune: false, logVerbosity: "normal", idleMinutes: 0, maintenance: "weekly", updateCheck: false, iconTier: "cached", iconReviewed: false
};

interface Ctx { settings: SettingsDoc; reload: () => Promise<void> }
const SettingsContext = createContext<Ctx>({ settings: DEFAULT_SETTINGS, reload: async () => {} });
export const useSettings = () => useContext(SettingsContext);

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<SettingsDoc>(DEFAULT_SETTINGS);
  const reload = useCallback(async () => { try { setSettings(await api.get<SettingsDoc>("/api/settings")); } catch { /* keep what we have */ } }, []);
  useEffect(() => { void reload(); }, [reload]);
  return <SettingsContext.Provider value={{ settings, reload }}>{children}</SettingsContext.Provider>;
}

/** 12/24-hour choice: "auto" follows the device's language. */
export const hour12Of = (s: SettingsDoc): boolean | undefined => (s.clock === "auto" ? undefined : s.clock === "12");

export function fmtTime(d: Date, s: SettingsDoc, hour12 = hour12Of(s)): string {
  return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit", hour12, timeZone: s.timezone });
}

/** Calendar day (YYYY-MM-DD) of a moment in the dashboard's time zone. */
export function dayKeyIn(d: Date, tz: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

export function fmtDateTime(ms: number, s: SettingsDoc): string {
  return new Date(ms).toLocaleString([], { timeZone: s.timezone, hour12: hour12Of(s), month: "short", day: "numeric", hour: "numeric", minute: "2-digit", second: "2-digit" });
}

export function timeZones(): string[] {
  try { return (Intl as any).supportedValuesOf("timeZone") as string[]; } catch { return [browserZone, "UTC"]; }
}
