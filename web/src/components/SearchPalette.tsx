import { useEffect, useMemo, useRef, useState } from "react";
import { WIDGET_BY_TYPE } from "../widgets";
import type { CameraInfo, Dashboard, IntegrationInfo } from "../types";
import { SECTIONS, type SectionId } from "../settings/SettingsPage";
import { Icon } from "./Icon";
import { addressOf, modeOf, useOpener } from "./Opener";

interface Entry { key: string; kind: string; title: string; sub: string; text: string; icon?: string; iconRef?: string; go: () => void }

const KIND_ORDER = ["Tab", "Tile", "App", "Connection", "Camera", "Settings"];

function score(e: Entry, tokens: string[]): number {
  const t = e.title.toLowerCase(); let s = 0;
  for (const tok of tokens) {
    if (t === tok) s += 100; else if (t.startsWith(tok)) s += 60; else if (t.split(/[\s\-_.]+/).some(w => w.startsWith(tok))) s += 40; else if (t.includes(tok)) s += 25;
    else if (e.text.includes(tok)) s += 8; else return -1;
  }
  return s;
}

/** Global search: tabs, tiles, Launcher links, connections, cameras and settings pages. `/` or Ctrl/Cmd+K opens it. */
export function SearchPalette({ doc, integrations, cameras, isAdmin, onClose, onTab, onSettings, onCamera }: {
  doc: Dashboard; integrations: IntegrationInfo[]; cameras: CameraInfo[]; isAdmin: boolean;
  onClose: () => void; onTab: (tabId: string, tileId?: string) => void; onSettings: (s: SectionId) => void; onCamera: (id: string) => void;
}) {
  const open = useOpener();
  const [q, setQ] = useState("");
  const [at, setAt] = useState(0);
  const ref = useRef<HTMLDialogElement>(null);
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => { ref.current?.showModal(); }, []);

  const all = useMemo(() => {
    const out: Entry[] = [];
    for (const t of doc.tabs) {
      out.push({ key: `tab:${t.id}`, kind: "Tab", title: t.name, sub: "Go to this tab", text: "", icon: t.icon, iconRef: t.iconRef, go: () => onTab(t.id) });
      for (const g of t.groups) for (const tile of g.tiles) {
        const label = WIDGET_BY_TYPE[tile.type]?.label ?? tile.type, custom = String(tile.config.title ?? "");
        const info = integrations.find(i => i.id === tile.config.integrationId);
        out.push({ key: `tile:${tile.id}`, kind: "Tile", title: custom || info?.name || label, sub: `${label} · ${t.name}`, text: `${label} ${info?.name ?? ""} ${g.name}`.toLowerCase(), icon: tile.config.icon as string | undefined, iconRef: tile.config.iconRef as string | undefined, go: () => onTab(t.id, tile.id) });
        for (const it of ((tile.config.items ?? []) as Array<{ id: string; name: string; url: string; note?: string; icon?: string; iconRef?: string; openMode?: string }>)) {
          if (!it?.url) continue;
          let host = ""; try { host = new URL(it.url).host; } catch { /* keep empty */ }
          out.push({ key: `app:${tile.id}:${it.id}`, kind: "App", title: it.name, sub: host || it.url, text: `${it.note ?? ""} ${it.url}`.toLowerCase(), icon: it.icon, iconRef: it.iconRef, go: () => open({ url: it.url, name: it.name, mode: it.openMode === "inapp" ? "inapp" : "tab" }) });
        }
      }
    }
    for (const i of integrations) {
      const url = addressOf(i);
      if (url) out.push({ key: `conn:${i.id}`, kind: "Connection", title: i.name, sub: `Open ${url.replace(/^https?:\/\//, "")}`, text: i.type, icon: i.icon, iconRef: i.iconRef, go: () => open({ url, name: i.name, mode: modeOf(i) }) });
    }
    for (const c of cameras) out.push({ key: `cam:${c.id}`, kind: "Camera", title: c.name, sub: "Open the camera", text: "camera", icon: c.icon, iconRef: c.iconRef, go: () => onCamera(c.id) });
    if (isAdmin) for (const s of SECTIONS) out.push({ key: `set:${s.id}`, kind: "Settings", title: s.label, sub: "Settings", text: "settings", go: () => onSettings(s.id) });
    return out;
  }, [doc, integrations, cameras, isAdmin]); // eslint-disable-line react-hooks/exhaustive-deps

  const shown = useMemo(() => {
    const tokens = q.toLowerCase().split(/\s+/).filter(Boolean);
    const seen = new Set<string>();
    const rows = (tokens.length ? all.map(e => ({ e, s: score(e, tokens) })).filter(x => x.s >= 0).sort((a, b) => b.s - a.s || KIND_ORDER.indexOf(a.e.kind) - KIND_ORDER.indexOf(b.e.kind)).map(x => x.e)
      : all.filter(e => e.kind === "Tab" || e.kind === "App" || e.kind === "Connection").slice(0, 12))
      // a connection and its tile have the same name; show the connection (it opens the app) once
      .filter(e => { const k = `${e.kind === "Tile" ? "t" : e.kind}|${e.title.toLowerCase()}|${e.sub}`; if (seen.has(k)) return false; seen.add(k); return true; });
    return rows.slice(0, 30);
  }, [all, q]);
  useEffect(() => { setAt(0); }, [q]);
  useEffect(() => { (list.current?.querySelector(".on") as HTMLElement | null)?.scrollIntoView({ block: "nearest" }); }, [at, shown]);

  const run = (e: Entry | undefined) => { if (!e) return; ref.current?.close(); e.go(); };
  const onKey = (ev: React.KeyboardEvent) => {
    if (ev.key === "ArrowDown") { ev.preventDefault(); setAt(a => Math.min(shown.length - 1, a + 1)); }
    else if (ev.key === "ArrowUp") { ev.preventDefault(); setAt(a => Math.max(0, a - 1)); }
    else if (ev.key === "Enter") { ev.preventDefault(); run(shown[at]); }
  };

  return (
    <dialog ref={ref} className="palette" onClose={onClose} onClick={e => { if (e.target === ref.current) ref.current?.close(); }} aria-label="Search">
      <div className="pal" onKeyDown={onKey}>
        <div className="pal-in">⌕<input autoFocus value={q} onChange={e => setQ(e.target.value)} placeholder="Search tabs, tiles, apps, cameras and settings…" aria-label="Search" role="combobox" aria-expanded="true" aria-controls="pal-list" /><kbd>Esc</kbd></div>
        <div className="pal-list" id="pal-list" role="listbox" ref={list}>
          {shown.length === 0 && <p className="quiet">Nothing matches “{q}”.</p>}
          {shown.map((e, i) => (
            <button key={e.key} type="button" role="option" aria-selected={i === at} className={`pal-row ${i === at ? "on" : ""}`} onMouseMove={() => setAt(i)} onClick={() => run(e)}>
              <Icon icon={e.icon} iconRef={e.iconRef} name={e.title} size={24} />
              <span className="pal-t"><b>{e.title}</b><small>{e.sub}</small></span>
              <em>{e.kind}</em>
            </button>
          ))}
        </div>
        <div className="pal-foot sub">↑↓ to move · Enter to open · Esc to close</div>
      </div>
    </dialog>
  );
}
