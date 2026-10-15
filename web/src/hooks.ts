import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError } from "./api";
import type { CameraInfo, Dashboard, IntegrationInfo, Snapshot, Tab } from "./types";

export interface AuthState { loaded: boolean; setup: boolean; authed: boolean }

export function useAuth() {
  const [state, setState] = useState<AuthState>({ loaded: false, setup: true, authed: false });
  const refresh = useCallback(async () => {
    try { const s = await api.get<{ setup: boolean; authed: boolean }>("/api/auth/status"); setState({ loaded: true, ...s }); }
    catch { setState(s => ({ ...s, loaded: true })); }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);
  return { auth: state, refreshAuth: refresh };
}

export type SaveState = "idle" | "saving" | "saved" | "error" | "conflict";

/** Holds the dashboard document. Edits update it immediately and save to the server shortly after. */
export function useDashboard(authed: boolean) {
  const [doc, setDoc] = useState<Dashboard | null>(null);
  const [save, setSave] = useState<SaveState>("idle");
  const [saveError, setSaveError] = useState("");
  const revision = useRef(0);
  const latest = useRef<Dashboard | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const dirty = useRef(false);

  const load = useCallback(async () => {
    const fresh = await api.get<Dashboard>("/api/dashboard");
    revision.current = fresh.revision; latest.current = fresh; dirty.current = false;
    setDoc(fresh); setSave("idle");
  }, []);
  useEffect(() => { void load(); }, [load]);

  const flush = useCallback(async () => {
    if (!dirty.current || !latest.current) return;
    dirty.current = false;
    setSave("saving");
    try {
      const saved = await api.put<Dashboard>("/api/dashboard", { tabs: latest.current.tabs, baseRevision: revision.current });
      revision.current = saved.revision;
      if (dirty.current) { void flush(); return; }
      setSave("saved");
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) setSave("conflict");
      else { setSave("error"); setSaveError(error instanceof Error ? error.message : "Could not save"); dirty.current = true; }
    }
  }, []);

  const update = useCallback((fn: (tabs: Tab[]) => Tab[]) => {
    if (!latest.current) return;
    const next = { ...latest.current, tabs: fn(latest.current.tabs) };
    latest.current = next; dirty.current = true;
    setDoc(next);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => void flush(), 600);
  }, [flush]);

  // Never lose a pending edit when the tab is closed or the user signs out.
  useEffect(() => {
    const onHide = () => { if (dirty.current && authed) void flush(); };
    window.addEventListener("pagehide", onHide);
    return () => window.removeEventListener("pagehide", onHide);
  }, [authed, flush]);

  return { doc, update, save, saveError, reload: load, retry: flush, flushNow: flush };
}

/** One server-sent-events connection delivers live updates for every tile. */
export function useLive() {
  const [snapshots, setSnapshots] = useState<Record<string, Snapshot>>({});
  const [connected, setConnected] = useState(false);
  useEffect(() => {
    const source = new EventSource("/api/stream");
    source.onopen = () => setConnected(true);
    source.onerror = () => setConnected(false);
    source.addEventListener("snapshot", e => { const s = JSON.parse((e as MessageEvent).data) as Snapshot; setSnapshots(prev => ({ ...prev, [s.id]: s })); });
    source.addEventListener("removed", e => { const { id } = JSON.parse((e as MessageEvent).data); setSnapshots(prev => { const next = { ...prev }; delete next[id]; return next; }); });
    return () => source.close();
  }, []);
  return { snapshots, connected };
}

export function useIntegrations(authed: boolean) {
  const [list, setList] = useState<IntegrationInfo[]>([]);
  const refresh = useCallback(async () => { try { setList(await api.get<IntegrationInfo[]>("/api/integrations")); } catch { /* keep old list */ } }, []);
  useEffect(() => { void refresh(); }, [refresh, authed]);
  return { integrations: list, refreshIntegrations: refresh };
}

export function useCameras() {
  const [cameras, setCameras] = useState<CameraInfo[]>([]);
  const refresh = useCallback(async () => { try { setCameras(await api.get<CameraInfo[]>("/api/cameras")); } catch { /* ignore */ } }, []);
  useEffect(() => { void refresh(); }, [refresh]);
  return { cameras, refreshCameras: refresh };
}

export function useSeries(instanceId: string | undefined, key: string, minutes = 360) {
  const [series, setSeries] = useState<Array<[number, number]>>([]);
  useEffect(() => {
    if (!instanceId) return;
    let stop = false;
    const load = () => api.get<Array<[number, number]>>(`/api/metrics/${instanceId}/${key}?minutes=${minutes}`).then(s => { if (!stop) setSeries(s); }).catch(() => {});
    void load();
    const t = window.setInterval(load, 60_000);
    return () => { stop = true; window.clearInterval(t); };
  }, [instanceId, key, minutes]);
  return series;
}

export function usePref<T extends string>(key: string, fallback: T): [T, (v: T) => void] {
  const [value, setValue] = useState<T>(() => { try { return (localStorage.getItem(key) as T) || fallback; } catch { return fallback; } });
  return [value, (v: T) => { setValue(v); try { localStorage.setItem(key, v); } catch { /* private mode */ } }];
}
