import { useEffect, useMemo, useRef, useState } from "react";
import { api, uid } from "./api";
import { useAuth, useCameras, useDashboard, useIntegrations, useLive, usePref } from "./hooks";
import { applyLayout, moveTile } from "./layout";
import type { Group, Tab, Tile } from "./types";
import { WIDGET_BY_TYPE } from "./widgets";
import { GroupView } from "./components/GroupView";
import { Lightbox } from "./components/Lightbox";
import { CameraPick } from "./components/CameraPick";
import { AuthDialog } from "./dialogs/AuthDialog";
import { CameraDialog } from "./dialogs/CameraDialog";
import { IconPicker } from "./dialogs/IconPicker";
import { IntegrationsDialog } from "./dialogs/IntegrationsDialog";
import { TabDialog } from "./dialogs/TabDialog";
import { TileSettings } from "./dialogs/TileSettings";

const ACCENTS = ["#6c8cff", "#3ecf8e", "#f5a524", "#f0616d", "#c04bff", "#35c5f4"];
const newGroup = (name: string, layout = "free"): Group => ({ id: uid(), name, layout, collapsed: false, tiles: [] });
const cloneTab = (tab: Tab, name: string): Tab => ({ ...tab, id: uid(), name, groups: tab.groups.map(g => ({ ...g, id: uid(), tiles: g.tiles.map(t => ({ ...t, id: uid(), config: JSON.parse(JSON.stringify(t.config)) })) })) });

export function App() {
  const { auth, refreshAuth } = useAuth();
  const { doc, update, save, saveError, reload, retry } = useDashboard(auth.authed);
  const { snapshots, connected } = useLive();
  const { integrations, refreshIntegrations } = useIntegrations(auth.authed);
  const { cameras, refreshCameras } = useCameras();
  const [theme, setTheme] = usePref<"dark" | "light" | "glass">("hb_theme", "dark");
  const [accent, setAccent] = usePref<string>("hb_accent", ACCENTS[0]);
  const [tabId, setTabId] = usePref<string>("hb_tab", "");
  const [editing, setEditing] = useState(false);
  const [query, setQuery] = useState("");
  const [dragId, setDragId] = useState<string | null>(null);
  const [dlg, setDlg] = useState<
    | { kind: "auth" } | { kind: "connections" } | { kind: "tab"; edit: boolean }
    | { kind: "settings"; tileId: string; v: number } | { kind: "icon"; tileId: string; itemId: string }
    | { kind: "camPick"; tileId: string } | { kind: "camera"; tileId: string; id?: string }
    | { kind: "lightbox"; cameraId: string } | null
  >(null);
  const search = useRef<HTMLInputElement>(null);

  useEffect(() => {
    document.body.className = theme === "dark" ? "" : theme;
    document.documentElement.style.setProperty("--accent", accent);
  }, [theme, accent]);
  useEffect(() => { if (!auth.authed) setEditing(false); }, [auth.authed]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (e.key === "/" && tag !== "INPUT" && tag !== "TEXTAREA" && tag !== "SELECT") { e.preventDefault(); search.current?.focus(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const tab = useMemo(() => doc?.tabs.find(t => t.id === tabId) ?? doc?.tabs[0], [doc, tabId]);

  // ---- editing helpers (all go through `update`, which saves in the background)
  const editTab = (fn: (tab: Tab) => Tab) => update(tabs => tabs.map(t => (t.id === tab?.id ? fn(t) : t)));
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
    } else { setConfig(tid, { cameraId: ids[0] }); setDlg(null); }
  };

  const addTile = (gid: string, type: string) => {
    const def = WIDGET_BY_TYPE[type]; if (!def) return;
    const tile: Tile = { id: uid(), type, w: def.size[0], h: def.size[1], config: {} };
    editGroup(gid, g => applyLayout({ ...g, tiles: [...g.tiles, tile] }));
    if (type === "camera") setDlg({ kind: "camPick", tileId: tile.id });
    else if (def.needs || type === "launcher") setDlg({ kind: "settings", tileId: tile.id, v: 0 });
  };
  const removeTile = (tid: string) => editTab(t => ({ ...t, groups: t.groups.map(g => applyLayout({ ...g, tiles: g.tiles.filter(x => x.id !== tid) })) }));
  const dropOn = (gid: string, before: string | null) => {
    if (!dragId) return;
    const id = dragId; setDragId(null);
    if (id === before) return;
    editTab(t => ({ ...t, groups: moveTile(t.groups, id, gid, before).map(g => applyLayout(g)) }));
  };

  const saveTab = (v: { name: string; emoji: string; template: "blank" | "cameras" | "copy" }) => {
    if (dlg?.kind !== "tab") return;
    if (dlg.edit && tab) update(tabs => tabs.map(t => (t.id === tab.id ? { ...t, name: v.name, emoji: v.emoji } : t)));
    else {
      let fresh: Tab = { id: uid(), name: v.name, emoji: v.emoji, groups: [newGroup("Group")] };
      if (v.template === "cameras") fresh = { ...fresh, groups: [newGroup("Outdoor", "grid3"), newGroup("Indoor", "grid3")] };
      if (v.template === "copy" && tab) fresh = { ...cloneTab(tab, v.name), emoji: v.emoji };
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
    editing, authed: auth.authed, snapshots, integrations, cameras, query,
    openCamera: (cameraId: string) => setDlg({ kind: "lightbox", cameraId }),
    refreshIntegrations,
    onDragStart: setDragId, onDragEnd: () => setDragId(null),
    onResize: (id: string, w: number, h: number) => editTile(id, t => ({ ...t, w, h })),
    onRemove: removeTile,
    onConfig: setConfig,
    onSettings: (t: Tile) => setDlg(t.type === "camera" ? { kind: "camPick", tileId: t.id } : { kind: "settings", tileId: t.id, v: 0 })
  };

  const settingsTile = dlg && "tileId" in dlg ? findTile(dlg.tileId) : undefined;

  if (!doc || !tab) return <div className="boot">{save === "error" ? saveError : "Loading…"}</div>;

  return (
    <>
      <header className="top">
        <div className="logo"><i />Homebase</div>
        <nav className="tabs" aria-label="Tabs">
          {doc.tabs.map(t => (
            <button key={t.id} className={`tab ${t.id === tab.id ? "on" : ""}`} onClick={() => { if (t.id === tab.id && editing) setDlg({ kind: "tab", edit: true }); else setTabId(t.id); }}>
              {t.emoji ? `${t.emoji} ` : ""}{t.name}{editing && t.id === tab.id ? <span className="tedit"> ✎</span> : null}
            </button>
          ))}
          {editing && <button className="tab add" aria-label="New tab" onClick={() => setDlg({ kind: "tab", edit: false })}>＋</button>}
        </nav>
        <label className="search">⌕ <input ref={search} value={query} onChange={e => setQuery(e.target.value)} placeholder="Search apps…" aria-label="Search" /><kbd>/</kbd></label>
        <div className="sw" role="group" aria-label="Accent colour">{ACCENTS.map(c => <b key={c} className={c === accent ? "on" : ""} style={{ background: c }} onClick={() => setAccent(c)} />)}</div>
        <select className="btn" value={theme} onChange={e => setTheme(e.target.value as any)} aria-label="Theme"><option value="dark">Dark</option><option value="light">Light</option><option value="glass">Glass</option></select>
        <span className={`conn ${connected ? "on" : ""}`} title={connected ? "Live updates connected" : "Reconnecting…"} />
        {auth.authed ? (
          <>
            {editing && <button className="btn" onClick={() => setDlg({ kind: "connections" })}>Connections</button>}
            <button className={`btn ${editing ? "pri" : ""}`} onClick={async () => { if (editing) await retry(); setEditing(!editing); }}>{editing ? "✓ Done" : "✎ Edit"}</button>
            {!editing && <button className="btn" onClick={async () => { await api.post("/api/auth/logout"); void refreshAuth(); }}>Sign out</button>}
          </>
        ) : <button className="btn" onClick={() => setDlg({ kind: "auth" })}>{auth.setup ? "Sign in to edit" : "Set up"}</button>}
      </header>

      {save === "conflict" && <div className="banner">This dashboard was changed somewhere else. <button className="btn sm" onClick={() => void reload()}>Load the latest</button> (your unsaved changes here will be replaced)</div>}
      {save === "error" && <div className="banner">Could not save: {saveError} <button className="btn sm" onClick={() => void retry()}>Try again</button></div>}

      <main className={editing ? "edit" : ""}>
        {editing && <div className="savestate sub">{save === "saving" ? "Saving…" : save === "saved" ? "All changes saved" : "Drag tiles to move them. Drag the corner handle to resize."}</div>}
        {tab.groups.map(group => (
          <GroupView key={group.id} group={group} editing={editing} dragId={dragId} shared={shared} canDelete={tab.groups.length > 1}
            onRename={name => editGroup(group.id, g => ({ ...g, name }))}
            onLayout={layout => editGroup(group.id, g => applyLayout({ ...g, layout }))}
            onToggle={() => editGroup(group.id, g => ({ ...g, collapsed: !g.collapsed }))}
            onDelete={() => editTab(t => ({ ...t, groups: t.groups.filter(g => g.id !== group.id) }))}
            onAddTile={type => addTile(group.id, type)}
            onDropIn={dropOn} />
        ))}
        {editing && <button className="btn" onClick={() => editTab(t => ({ ...t, groups: [...t.groups, newGroup("New group")] }))}>＋ Add group</button>}
      </main>

      {dlg?.kind === "auth" && <AuthDialog setup={!auth.setup} onClose={() => setDlg(null)} onDone={() => { setDlg(null); void refreshAuth(); }} />}
      {dlg?.kind === "connections" && <IntegrationsDialog integrations={integrations} onChanged={refreshIntegrations} onClose={() => setDlg(null)} />}
      {dlg?.kind === "tab" && <TabDialog tab={dlg.edit ? tab : undefined} canDelete={doc.tabs.length > 1} onSave={saveTab} onDelete={deleteTab} onClose={() => setDlg(null)} />}
      {dlg?.kind === "settings" && settingsTile && (
        <TileSettings key={dlg.v} tile={settingsTile} integrations={integrations} cameras={cameras}
          onAddCameras={() => setDlg({ kind: "camera", tileId: settingsTile.id })}
          onChange={patch => setConfig(settingsTile.id, patch)}
          onPickIcon={itemId => setDlg({ kind: "icon", tileId: settingsTile.id, itemId })}
          onOpenConnections={() => setDlg({ kind: "connections" })} onClose={() => setDlg(null)} />
      )}
      {dlg?.kind === "icon" && settingsTile && (
        <IconPicker
          current={((settingsTile.config.items ?? []) as any[]).find(i => i.id === dlg.itemId)?.icon}
          onClose={() => setDlg({ kind: "settings", tileId: dlg.tileId, v: 1 })}
          onPick={icon => {
            const items = ((settingsTile.config.items ?? []) as any[]).map(i => (i.id === dlg.itemId ? { ...i, icon } : i));
            setConfig(settingsTile.id, { items });
            setDlg({ kind: "settings", tileId: dlg.tileId, v: Date.now() });
          }} />
      )}
      {dlg?.kind === "camPick" && settingsTile && (
        <CameraPick cameras={cameras} current={settingsTile.config.cameraId as string | undefined}
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
      {dlg?.kind === "lightbox" && <Lightbox cameraId={dlg.cameraId} cameras={cameras} onClose={() => setDlg(null)} />}
    </>
  );
}
