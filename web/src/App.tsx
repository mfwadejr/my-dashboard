import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as RPointerEvent } from "react";
import { api, uid } from "./api";
import { useAuth, useCameras, useDashboard, useIdleGuard, useIntegrations, useLive, usePref, type AuthState } from "./hooks";
import { SettingsProvider, useSettings } from "./settings";
import { SignIn } from "./pages/SignIn";
import { ShareView } from "./pages/ShareView";
import { StatusView } from "./pages/StatusView";
import { Monitoring } from "./pages/Monitoring";
import { SettingsPage, SECTIONS, type SectionId } from "./settings/SettingsPage";
import { AccountDialog } from "./dialogs/AccountDialog";
import type { AboutInfo } from "./types";
import { applyLayout } from "./layout";
import { ROW_H, GRID_COLS, rowsUsed, clampCol, normalizeGroup, normalizeTab, placeTile, reflow, resizeTile, settle, spanOf } from "./grid";
import type { Group, Tab, Tile } from "./types";
import { WIDGET_BY_TYPE } from "./widgets";
import { GroupView, type Placeholder } from "./components/GroupView";
import { Lightbox } from "./components/Lightbox";
import { CameraPick } from "./components/CameraPick";
import { CameraDialog } from "./dialogs/CameraDialog";
import { Modal } from "./dialogs/Modal";
import { Icon } from "./components/Icon";
import { SearchPalette } from "./components/SearchPalette";
import { IntegrationsDialog } from "./dialogs/IntegrationsDialog";
import { TabDialog } from "./dialogs/TabDialog";
import { TileSettings } from "./dialogs/TileSettings";

interface DragState { tileId: string; fromGroup: string; w: number; h: number; grabX: number; grabY: number; label: string; over: string | null; x: number; y: number; frozen: Record<string, number> }
const newGroup = (name: string, layout = "free"): Group => ({ id: uid(), name, layout, collapsed: false, tiles: [] });
const cloneTab = (tab: Tab, name: string): Tab => ({ ...tab, id: uid(), name, groups: tab.groups.map(g => ({ ...g, id: uid(), tiles: g.tiles.map(t => ({ ...t, id: uid(), config: JSON.parse(JSON.stringify(t.config)) })) })) });

/** A link someone sent (/s/<token>) shows only the shared cameras. Anything else needs a signed-in account. */
export function App() {
  const shareToken = /^\/s\/([A-Za-z0-9_-]{20,80})\/?$/.exec(window.location.pathname)?.[1];
  const statusToken = /^\/status\/([A-Za-z0-9_-]{20,80})\/?$/.exec(window.location.pathname)?.[1];
  return statusToken ? <StatusView token={statusToken} /> : shareToken ? <ShareView token={shareToken} /> : <Gate />;
}

function Gate() {
  const { auth, refreshAuth } = useAuth();
  if (!auth.loaded) return <div className="boot">Loading…</div>;
  if (!auth.authed || !auth.user) return <SignIn setup={!auth.setup} onDone={() => void refreshAuth()} />;
  return <SettingsProvider><Home auth={auth} refreshAuth={refreshAuth} /></SettingsProvider>;
}

const parseSettingsHash = (): SectionId | null => {
  const m = /^#settings\/(\w+)/.exec(window.location.hash);
  return SECTIONS.find(x => x.id === m?.[1])?.id ?? null;
};

const parseMonitoringHash = () => window.location.hash === "#monitoring";

function Home({ auth, refreshAuth }: { auth: AuthState; refreshAuth: () => Promise<void> }) {
  const me = auth.user!;
  const isAdmin = me.role === "admin";
  const { settings, reload: reloadSettings } = useSettings();
  const { doc, update, save, saveError, reload, retry } = useDashboard(true);
  const { snapshots, connected, serverBuild } = useLive();
  const { integrations, refreshIntegrations } = useIntegrations(true);
  const { cameras, refreshCameras } = useCameras();
  const [prefs, setPrefs] = useState(auth.prefs);
  const savePrefs = useCallback((patch: Partial<typeof auth.prefs>) => {
    setPrefs(p => ({ ...p, ...patch }));
    if (!auth.kiosk) void api.put("/api/auth/prefs", patch).catch(() => {});
  }, [auth.kiosk]);
  const devTheme = prefs.theme ?? "", devAccent = prefs.accent ?? "";
  const setDevTheme = (v: string) => savePrefs({ theme: v });
  const setDevAccent = (v: string) => savePrefs({ accent: v });
  const [devKiosk, setDevKiosk] = usePref<string>("hb_kiosk", "");
  const [about, setAbout] = useState<AboutInfo | null>(null);
  const [page, setPage] = useState<SectionId | null>(parseSettingsHash);
  const [monitoring, setMonitoring] = useState(parseMonitoringHash);
  const [systemDark, setSystemDark] = useState(() => window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? true);
  const kioskParam = new URLSearchParams(window.location.search).get("kiosk");
  const kiosk = auth.kiosk || kioskParam === "1" || (devKiosk === "1" && kioskParam !== "0");
  const theme = ((devTheme || settings.theme) === "auto" ? (systemDark ? "dark" : "light") : (devTheme || settings.theme)) as "dark" | "light" | "glass";
  const accent = devAccent || settings.accent;
  const tabId = prefs.tab ?? "";
  const setTabId = useCallback((v: string) => { if (kiosk) setPrefs(p => ({ ...p, tab: v })); else savePrefs({ tab: v }); }, [kiosk, savePrefs]);
  const [editing, setEditing] = useState(false);
  const query = "";
  const [drag, setDrag] = useState<DragState | null>(null);
  const ghost = useRef<HTMLDivElement>(null);
  const ghostPos = useRef({ x: 0, y: 0 });
  const [dlg, setDlg] = useState<
    | { kind: "account" } | { kind: "connections" } | { kind: "tab"; edit: boolean }
    | { kind: "settings"; tileId: string; v: number }
    | { kind: "camPick"; tileId: string } | { kind: "camera"; tileId: string; id?: string }
    | { kind: "lightbox"; cameraId: string } | { kind: "imported"; tileId: string; ids: string[] } | null
  >(null);
  const [palette, setPalette] = useState(false);

  useEffect(() => {
    document.body.className = theme === "dark" ? "" : theme;
    document.documentElement.style.setProperty("--accent", accent);
    document.title = settings.name;
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", getComputedStyle(document.body).getPropertyValue("--bg").trim() || "#0f1117");
  }, [theme, accent, settings.name]);
  useEffect(() => { void api.get<AboutInfo>("/api/about").then(setAbout).catch(() => {}); }, [serverBuild]);
  useEffect(() => {
    const mq = window.matchMedia?.("(prefers-color-scheme: dark)");
    if (!mq) return;
    const f = () => setSystemDark(mq.matches);
    mq.addEventListener("change", f);
    return () => mq.removeEventListener("change", f);
  }, []);
  useEffect(() => {
    const f = () => { setPage(parseSettingsHash()); setMonitoring(parseMonitoringHash()); };
    window.addEventListener("hashchange", f);
    return () => window.removeEventListener("hashchange", f);
  }, []);
  useEffect(() => { if (!isAdmin || kiosk) setEditing(false); }, [isAdmin, kiosk]);
  useIdleGuard(isAdmin, kiosk, settings.idleMinutes, () => void refreshAuth());

  // The server was updated while this page was open: a banner here, an automatic reload on a wall display.
  const outdated = Boolean(serverBuild && serverBuild !== __BUILD__);
  useEffect(() => { if (outdated && kiosk) { const t = window.setTimeout(() => window.location.reload(), 3000); return () => window.clearTimeout(t); } }, [outdated, kiosk]);

  // Wall display: keep the screen awake and move through the tabs if asked to.
  useEffect(() => {
    if (!kiosk) return;
    let lock: { release: () => Promise<void> } | null = null;
    const ask = async () => { try { lock = await (navigator as any).wakeLock?.request("screen"); } catch { /* not allowed or not supported */ } };
    void ask();
    const onVis = () => { if (!document.hidden) void ask(); };
    document.addEventListener("visibilitychange", onVis);
    return () => { document.removeEventListener("visibilitychange", onVis); void lock?.release().catch(() => {}); };
  }, [kiosk]);
  useEffect(() => {
    if (!kiosk || !settings.kioskCycleSeconds || !doc || doc.tabs.length < 2) return;
    const t = window.setInterval(() => {
      const ids = doc.tabs.map(x => x.id), at = ids.indexOf(tabId);
      setTabId(ids[(at + 1) % ids.length]);
    }, settings.kioskCycleSeconds * 1000);
    return () => window.clearInterval(t);
  }, [kiosk, settings.kioskCycleSeconds, doc, tabId, setTabId]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (((e.key === "/" && tag !== "INPUT" && tag !== "TEXTAREA" && tag !== "SELECT") || ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k")) && !document.querySelector("dialog[open]")) { e.preventDefault(); setPalette(true); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const gotoSettings = (s: SectionId) => { setEditing(false); window.location.hash = `settings/${s}`; };
  const closeSettings = () => { window.history.pushState(null, "", window.location.pathname + window.location.search); setPage(null); setMonitoring(false); };
  const gotoMonitoring = () => { setEditing(false); window.location.hash = "monitoring"; };

  const rawTab = useMemo(() => doc?.tabs.find(t => t.id === tabId) ?? doc?.tabs[0], [doc, tabId]);
  // Every tile gets a spot (old dashboards are laid out the way they looked); nothing is saved until you change something.
  const tab = useMemo(() => (rawTab ? normalizeTab(rawTab) : rawTab), [rawTab]);

  // ---- editing helpers (all go through `update`, which saves in the background)
  const editTab = (fn: (tab: Tab) => Tab) => update(tabs => tabs.map(t => (t.id === tab?.id ? fn(normalizeTab(t)) : t)));
  const editGroup = (gid: string, fn: (g: Group) => Group) => editTab(t => ({ ...t, groups: t.groups.map(g => (g.id === gid ? fn(g) : g)) }));
  const editTile = (tid: string, fn: (t: Tile) => Tile) => editTab(t => ({ ...t, groups: t.groups.map(g => ({ ...g, tiles: g.tiles.map(x => (x.id === tid ? fn(x) : x)) })) }));
  const findTile = (tid: string) => tab?.groups.flatMap(g => g.tiles).find(t => t.id === tid);
  const setConfig = (tid: string, patch: Record<string, unknown>) => editTile(tid, t => ({ ...t, config: { ...t.config, ...patch } }));

  /** A camera was saved or imported from a tile's dialog: a camera tile shows it, a camera wall adds it to its list. */
  const afterCameraAdded = (tid: string, ids: string[]) => {
    const t = findTile(tid);
    if (t?.type === "camerawall") {
      const have = (t.config.cameraIds ?? []) as string[];
      setConfig(tid, { cameraIds: [...have, ...ids.filter(id => !have.includes(id))] });
      setDlg({ kind: "settings", tileId: tid, v: Date.now() });
    } else if (ids.length > 1) setDlg({ kind: "imported", tileId: tid, ids });
    else { setConfig(tid, { cameraId: ids[0] }); setDlg(null); }
  };
  /** Several cameras arrived from a single camera tile: turn it into a wall, or give each camera its own tile. */
  const makeWall = (tid: string, ids: string[]) => {
    editTab(t => ({ ...t, groups: t.groups.map(g => {
      const tile = g.tiles.find(x => x.id === tid);
      if (!tile) return g;
      const grown = resizeTile(g, tid, Math.max(tile.w, 6), Math.max(tile.h, 5));
      return { ...grown, tiles: grown.tiles.map(x => (x.id === tid ? { ...x, type: "camerawall", config: { cameraIds: [...new Set([...(tile.config.cameraId ? [String(tile.config.cameraId)] : []), ...ids])], mode: "snapshot", refresh: 10 } } : x)) };
    }) }));
    setDlg(null);
  };
  const splitTiles = (tid: string, ids: string[]) => {
    const g = tab?.groups.find(x => x.tiles.some(y => y.id === tid));
    if (!g) return setDlg(null);
    const size = WIDGET_BY_TYPE.camera.size;
    editGroup(g.id, grp => afterChange({ ...grp, tiles: [
      ...grp.tiles.map(x => (x.id === tid ? { ...x, config: { ...x.config, cameraId: ids[0] } } : x)),
      ...ids.slice(1).map(id => ({ id: uid(), type: "camera", w: size[0], h: size[1], config: { cameraId: id } }))
    ] }));
    setDlg(null);
  };

  const addTile = (gid: string, type: string) => {
    const def = WIDGET_BY_TYPE[type]; if (!def) return;
    const tile: Tile = { id: uid(), type, w: def.size[0], h: def.size[1], config: {} };
    editGroup(gid, g => afterChange({ ...g, tiles: [...g.tiles, tile] }));
    if (type === "camera") setDlg({ kind: "camPick", tileId: tile.id });
    else if (def.needs || type === "launcher") setDlg({ kind: "settings", tileId: tile.id, v: 0 });
  };
  /** After tiles are added or removed: preset groups re-flow into their pattern, free groups just place any new tile in the first free spot. */
  const afterChange = (g: Group): Group => (g.layout === "free" ? normalizeGroup(g) : reflow(applyLayout(g)));
  const removeTile = (tid: string) => editTab(t => ({ ...t, groups: t.groups.map(g => (g.tiles.some(x => x.id === tid) ? afterChange({ ...g, tiles: g.tiles.filter(x => x.id !== tid) }) : g)) }));

  // ---- dragging a tile anywhere in a group, or into another group
  const beginDrag = (tile: Tile, groupId: string, e: RPointerEvent<HTMLElement>) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    const el = (e.currentTarget as HTMLElement).closest<HTMLElement>(".tile");
    if (!el) return;
    const r = el.getBoundingClientRect();
    const label = WIDGET_BY_TYPE[tile.type]?.label ?? "Tile";
    // Each group keeps the height it had when the drag began (plus two spare rows), so the page does not jump under the pointer.
    const frozen = Object.fromEntries((tab?.groups ?? []).map(g => [g.id, rowsUsed(g.tiles) + 2]));
    const base = { tileId: tile.id, fromGroup: groupId, w: r.width, h: r.height, grabX: e.clientX - r.left, grabY: e.clientY - r.top, label, frozen };
    const startX = e.clientX, startY = e.clientY, cw = spanOf(tile);
    let active = false, scroller = 0;
    let cur = { over: groupId as string | null, x: tile.x ?? 0, y: tile.y ?? 0 };
    let pointer = { x: startX, y: startY };

    const aim = () => {
      ghostPos.current = { x: pointer.x - base.grabX, y: pointer.y - base.grabY };
      if (ghost.current) ghost.current.style.transform = `translate(${ghostPos.current.x}px, ${ghostPos.current.y}px)`;
      const grid = document.elementsFromPoint(pointer.x, pointer.y).find((n): n is HTMLElement => n instanceof HTMLElement && Boolean(n.dataset.grid));
      if (!grid) return;
      const gap = parseFloat(getComputedStyle(grid).columnGap) || 14;
      const box = grid.getBoundingClientRect();
      const step = (box.width - gap * (GRID_COLS - 1)) / GRID_COLS + gap;
      const next = {
        over: grid.dataset.grid!,
        x: clampCol((pointer.x - base.grabX - box.left) / step, cw),
        y: Math.max(0, Math.round((pointer.y - base.grabY - box.top) / (ROW_H + gap)))
      };
      next.y = Math.min(next.y, Math.max(0, (base.frozen[next.over] ?? 99) - tile.h));
      if (next.over !== cur.over || next.x !== cur.x || next.y !== cur.y) { cur = next; setDrag(d => (d ? { ...d, ...cur } : d)); }
    };
    const stop = () => {
      window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel); window.removeEventListener("keydown", key);
      window.clearInterval(scroller); document.body.classList.remove("dragging"); setDrag(null);
    };
    const move = (ev: PointerEvent) => {
      pointer = { x: ev.clientX, y: ev.clientY };
      if (!active) {
        if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < 5) return;
        active = true;
        ghostPos.current = { x: ev.clientX - base.grabX, y: ev.clientY - base.grabY };
        setDrag({ ...base, ...cur });
        document.body.classList.add("dragging");
        // Scrolls the page when the pointer is near the top or bottom edge, so a tile can be carried a long way.
        scroller = window.setInterval(() => {
          if (pointer.y < 80) window.scrollBy(0, -Math.ceil((80 - pointer.y) / 4));
          else if (pointer.y > window.innerHeight - 80) window.scrollBy(0, Math.ceil((pointer.y - (window.innerHeight - 80)) / 4));
          aim();
        }, 30);
      }
      aim();
    };
    const up = () => { const place = cur; const was = active; stop(); if (was && place.over) commitMove(tile.id, place.over, place.x, place.y); };
    const cancel = () => stop();
    const key = (ev: KeyboardEvent) => { if (ev.key === "Escape") stop(); };
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel); window.addEventListener("keydown", key);
  };
  const commitMove = (tileId: string, toGroup: string, x: number, y: number) => editTab(t => {
    const moving = t.groups.flatMap(g => g.tiles).find(x2 => x2.id === tileId);
    if (!moving) return t;
    return { ...t, groups: t.groups.map(g => {
      if (g.id === toGroup) return placeTile(g, moving, x, y);
      if (g.tiles.some(x2 => x2.id === tileId)) return afterChange({ ...g, tiles: g.tiles.filter(x2 => x2.id !== tileId) });
      return g;
    }) };
  });
  /** What each group looks like right now while a tile is being dragged: the others make room around the landing spot. */
  const dragView = useMemo(() => {
    if (!drag || !tab) return null;
    const moving = tab.groups.flatMap(g => g.tiles).find(x => x.id === drag.tileId);
    if (!moving) return null;
    const out: Record<string, { tiles: Tile[]; ph: Placeholder | null }> = {};
    for (const g of tab.groups) {
      const others = g.tiles.filter(x => x.id !== drag.tileId);
      const hasIt = others.length !== g.tiles.length;
      if (g.id === drag.over) {
        const cw = spanOf(moving);
        const settled = settle(others, { id: moving.id, x: drag.x, y: drag.y, cw, h: moving.h }, Boolean(g.pack));
        out[g.id] = { tiles: g.tiles.map(x => (x.id === moving.id ? x : settled.find(o => o.id === x.id)!)), ph: { x: drag.x, y: drag.y, cw, h: moving.h } };
      } else if (hasIt) {
        const settled = settle(others, null, Boolean(g.pack));
        out[g.id] = { tiles: g.tiles.map(x => (x.id === moving.id ? x : settled.find(o => o.id === x.id)!)), ph: null };
      }
    }
    return out;
  }, [drag, tab]);

  const saveTab = (v: { name: string; emoji: string; icon: string; iconRef: string; template: "blank" | "cameras" | "copy" }) => {
    if (dlg?.kind !== "tab") return;
    if (dlg.edit && tab) update(tabs => tabs.map(t => (t.id === tab.id ? { ...t, name: v.name, emoji: v.emoji, icon: v.icon, iconRef: v.iconRef } : t)));
    else {
      let fresh: Tab = { id: uid(), name: v.name, emoji: v.emoji, icon: v.icon, iconRef: v.iconRef, groups: [newGroup("Group")] };
      if (v.template === "cameras") fresh = { ...fresh, groups: [newGroup("Outdoor", "grid3"), newGroup("Indoor", "grid3")] };
      if (v.template === "copy" && tab) fresh = { ...cloneTab(tab, v.name), emoji: v.emoji, icon: v.icon, iconRef: v.iconRef };
      update(tabs => [...tabs, fresh]);
      setTabId(fresh.id);
    }
    setDlg(null);
  };
  const deleteTab = () => {
    if (!tab || !doc || doc.tabs.length < 2) return;
    const rest = doc.tabs.filter(t => t.id !== tab.id);
    update(() => rest); setTabId(rest[0].id); setDlg(null);
  };

  const shared = {
    editing, authed: isAdmin, snapshots, integrations, cameras, query,
    openCamera: (cameraId: string) => setDlg({ kind: "lightbox", cameraId }),
    refreshIntegrations,
    onResize: (id: string, w: number, h: number) => editTab(t => ({ ...t, groups: t.groups.map(g => (g.tiles.some(x => x.id === id) ? resizeTile(g, id, w, h) : g)) })),
    onRemove: removeTile,
    onConfig: setConfig,
    onSettings: (t: Tile) => setDlg(t.type === "camera" ? { kind: "camPick", tileId: t.id } : { kind: "settings", tileId: t.id, v: 0 })
  };

  const settingsTile = dlg && "tileId" in dlg ? findTile(dlg.tileId) : undefined;

  if (!doc || !tab) return <div className="boot">{save === "error" ? saveError : "Loading…"}</div>;

  return (
    <>
      {!kiosk && <header className="top">
        <div className="logo"><i />{settings.name}</div>
        <nav className="tabs" aria-label="Tabs">
          {doc.tabs.map(t => (
            <button key={t.id} className={`tab ${t.id === tab.id && !page && !monitoring ? "on" : ""}`} onClick={() => { if (page || monitoring) closeSettings(); if (t.id === tab.id && editing && !page) setDlg({ kind: "tab", edit: true }); else setTabId(t.id); }}>
              {t.icon ? <Icon icon={t.icon} iconRef={t.iconRef} name={t.name} size={16} className="tab-ic" /> : t.emoji ? `${t.emoji} ` : ""}{t.name}{editing && t.id === tab.id && !page ? <span className="tedit"> ✎</span> : null}
            </button>
          ))}
          {!editing && <button className={`tab ${monitoring && !page ? "on" : ""}`} onClick={() => (monitoring ? closeSettings() : gotoMonitoring())}>Monitoring</button>}
          {editing && <button className="tab add" aria-label="New tab" onClick={() => setDlg({ kind: "tab", edit: false })}>＋</button>}
        </nav>
        <button type="button" className="search" onClick={() => setPalette(true)} aria-label="Search everything">⌕ <span>Search…</span><kbd>/</kbd></button>
        {isAdmin ? <button className={`conn ${connected ? "on" : ""}`} aria-label="Live updates: open the status page" title={connected ? "Live updates connected. Click for status." : "Reconnecting… Click for status."} onClick={() => gotoSettings("status")} />
          : <span className={`conn ${connected ? "on" : ""}`} title={connected ? "Live updates connected" : "Reconnecting…"} />}
        {isAdmin && editing && !page && !monitoring && <button className="btn" onClick={() => setDlg({ kind: "connections" })}>Connections</button>}
        {isAdmin && !page && !monitoring && <button className={`btn ${editing ? "pri" : ""}`} onClick={async () => { if (editing) await retry(); setEditing(!editing); }}>{editing ? "✓ Done" : "✎ Edit"}</button>}
        {isAdmin && !editing && <button className={`btn ${page ? "pri" : ""}`} aria-label="Settings" title="Settings" onClick={() => (page ? closeSettings() : gotoSettings("general"))}>⚙{page ? " Close" : ""}</button>}
        {!editing && <button className="btn" title="Your account" onClick={() => setDlg({ kind: "account" })}>{me.icon ? <Icon icon={me.icon} iconRef={me.iconRef} name={me.username} size={16} className="tab-ic" /> : null}{me.username}</button>}
        {!editing && !auth.kiosk && <button className="btn" onClick={async () => { await api.post("/api/auth/logout"); void refreshAuth(); }}>Sign out</button>}
      </header>}
      {kiosk && !auth.kiosk && <button className="kiosk-exit" aria-label="Leave wall display" title="Leave wall display mode" onClick={() => { setDevKiosk(""); window.location.href = "/?kiosk=0"; }}>✕</button>}
      {outdated && (
        <div className="banner">A new version of Homebase is running on the server.{" "}
          <button className="btn sm" onClick={() => window.location.reload()}>Reload this page</button>
          {about && <span className="sub">now {about.version} ({about.commit})</span>}</div>
      )}

      {save === "conflict" && <div className="banner">This dashboard was changed somewhere else. <button className="btn sm" onClick={() => void reload()}>Load the latest</button> (your unsaved changes here will be replaced)</div>}
      {save === "error" && <div className="banner">Could not save: {saveError} <button className="btn sm" onClick={() => void retry()}>Try again</button></div>}

      {page && isAdmin ? (
        <main className="settings-main">
          <SettingsPage section={page} onSection={gotoSettings} me={me} integrations={integrations} cameras={cameras} about={about}
            device={{ theme: devTheme, setTheme: setDevTheme, accent: devAccent, setAccent: setDevAccent, kiosk: devKiosk === "1", setKiosk: on => setDevKiosk(on ? "1" : "") }}
            openConnections={() => setDlg({ kind: "connections" })}
            onRestored={() => { void reload(); refreshIntegrations(); refreshCameras(); void reloadSettings(); }}
            onSignedOut={() => void refreshAuth()} />
        </main>
      ) : monitoring ? (
        <main className="settings-main"><Monitoring me={me} onSettings={() => gotoSettings("monitors")} /></main>
      ) : (
      <main className={editing ? "edit" : ""}>
        {editing && <div className="savestate sub">{save === "saving" ? "Saving…" : save === "saved" ? "All changes saved" : "Drag a tile anywhere to move it, or into another group. Drag the corner to resize. Esc cancels a drag."}</div>}
        {tab.groups.map(group => (
          <GroupView key={group.id} group={group} tiles={dragView?.[group.id]?.tiles ?? group.tiles} placeholder={dragView?.[group.id]?.ph ?? null}
            liftedId={drag && drag.fromGroup === group.id ? drag.tileId : null} minRows={drag?.frozen[group.id] ?? 0} editing={editing} shared={shared} canDelete={tab.groups.length > 1}
            onRename={name => editGroup(group.id, g => ({ ...g, name }))}
            onLayout={layout => editGroup(group.id, g => (layout === "free" ? { ...g, layout } : reflow(applyLayout({ ...g, layout }))))}
            onPack={on => editGroup(group.id, g => normalizeGroup({ ...g, pack: on }))}
            onToggle={() => editGroup(group.id, g => ({ ...g, collapsed: !g.collapsed }))}
            onDelete={() => editTab(t => ({ ...t, groups: t.groups.filter(g => g.id !== group.id) }))}
            onAddTile={type => addTile(group.id, type)}
            onGrab={beginDrag} />
        ))}
        {editing && <button className="btn" onClick={() => editTab(t => ({ ...t, groups: [...t.groups, newGroup("New group")] }))}>＋ Add group</button>}
      </main>
      )}
      {kiosk && doc.tabs.length > 1 && <div className="kiosk-dots" role="tablist">{doc.tabs.map(t => <button key={t.id} role="tab" aria-selected={t.id === tab.id} aria-label={t.name} className={t.id === tab.id ? "on" : ""} onClick={() => setTabId(t.id)} />)}</div>}
      {!kiosk && <footer className="pagefoot sub">{about ? `Homebase ${about.version} · ${about.commit}` : ""}</footer>}

      {drag && <div ref={ghost} className="ghost" style={{ width: drag.w, height: drag.h, transform: `translate(${ghostPos.current.x}px, ${ghostPos.current.y}px)` }}>{drag.label}</div>}
      {palette && <SearchPalette doc={doc} integrations={integrations} cameras={cameras} isAdmin={isAdmin} onClose={() => setPalette(false)}
        onTab={(tid, tile) => { if (page || monitoring) closeSettings(); setTabId(tid); if (tile) window.setTimeout(() => { const el = document.querySelector(`[data-tile="${tile}"]`); el?.scrollIntoView({ block: "center", behavior: "smooth" }); el?.classList.add("flash"); window.setTimeout(() => el?.classList.remove("flash"), 1800); }, 150); }}
        onSettings={gotoSettings} onCamera={id => setDlg({ kind: "lightbox", cameraId: id })} />}
      {dlg?.kind === "account" && <AccountDialog me={me} onSignedOut={() => void refreshAuth()} onClose={() => setDlg(null)} />}
      {dlg?.kind === "connections" && <IntegrationsDialog integrations={integrations} onChanged={refreshIntegrations} onClose={() => setDlg(null)} />}
      {dlg?.kind === "tab" && <TabDialog tab={dlg.edit ? tab : undefined} canDelete={doc.tabs.length > 1} onSave={saveTab} onDelete={deleteTab} onClose={() => setDlg(null)} />}
      {dlg?.kind === "settings" && settingsTile && (
        <TileSettings key={dlg.v} tile={settingsTile} integrations={integrations} cameras={cameras}
          onAddCameras={() => setDlg({ kind: "camera", tileId: settingsTile.id })}
          onChange={patch => setConfig(settingsTile.id, patch)}
          onOpenConnections={() => setDlg({ kind: "connections" })} onClose={() => setDlg(null)} />
      )}
      {dlg?.kind === "camPick" && settingsTile && (
        <CameraPick cameras={cameras} onChanged={refreshCameras} current={settingsTile.config.cameraId as string | undefined}
          config={settingsTile.config} onConfig={patch => setConfig(settingsTile.id, patch)}
          onPick={id => { setConfig(settingsTile.id, { cameraId: id }); setDlg(null); }}
          onAdd={() => setDlg({ kind: "camera", tileId: settingsTile.id })}
          onEdit={id => setDlg({ kind: "camera", tileId: settingsTile.id, id })}
          onClose={() => setDlg(null)} />
      )}
      {dlg?.kind === "camera" && (
        <CameraDialog cameraId={dlg.id} integrations={integrations}
          onSaved={id => { refreshCameras(); afterCameraAdded(dlg.tileId, [id]); }}
          onImported={ids => { refreshCameras(); afterCameraAdded(dlg.tileId, ids); }}
          onRemove={dlg.id ? async () => { await api.del(`/api/cameras/${dlg.id}`); refreshCameras(); setDlg(null); } : undefined}
          onClose={() => setDlg(null)} />
      )}
      {dlg?.kind === "imported" && (
        <Modal title={`${dlg.ids.length} cameras imported`} eyebrow="Camera import" onClose={() => setDlg(null)}>
          <p className="sub">A camera tile shows one camera. How do you want to show these {dlg.ids.length}?</p>
          <div className="form">
            <button type="button" className="btn pri" onClick={() => makeWall(dlg.tileId, dlg.ids)}>All in one camera wall (snapshots)</button>
            <button type="button" className="btn" onClick={() => splitTiles(dlg.tileId, dlg.ids)}>A separate tile for each camera</button>
            <button type="button" className="btn" onClick={() => { setConfig(dlg.tileId, { cameraId: dlg.ids[0] }); setDlg(null); }}>Just show the first one for now</button>
          </div>
          <small className="sub">They are all saved either way. You can add the others later from any camera tile's picker.</small>
        </Modal>
      )}
      {dlg?.kind === "lightbox" && <Lightbox cameraId={dlg.cameraId} cameras={cameras} onClose={() => setDlg(null)} />}
    </>
  );
}
