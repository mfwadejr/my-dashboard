import type { WidgetProps } from "./types";
import { Title, initials } from "./common";
import { Icon } from "../components/Icon";

export interface LauncherItem { id: string; name: string; url: string; icon?: string | null; iconRef?: string | null; integrationId?: string | null; note?: string }

export function Launcher({ tile, snapshots, query, editing }: WidgetProps) {
  const items = (tile.config.items ?? []) as LauncherItem[];
  const q = query.trim().toLowerCase();
  const shown = q ? items.filter(i => i.name.toLowerCase().includes(q) || (i.note ?? "").toLowerCase().includes(q)) : items;
  return (
    <>
      <Title>{tile.config.title ? String(tile.config.title) : "Apps"}</Title>
      {items.length === 0 && <div className="empty-note">{editing ? "Use the ⚙ button to add apps." : "No apps yet."}</div>}
      <div className="apps">
        {shown.map(item => {
          const snap = item.integrationId ? snapshots[item.integrationId] : undefined;
          const status = snap ? (snap.ok ? "ok" : "bad") : "";
          return (
            <a key={item.id} className="app" href={editing ? undefined : item.url} target="_blank" rel="noreferrer noopener" onClick={e => editing && e.preventDefault()} draggable={false}>
              {status && <span className={`dot ${status}`} title={snap?.ok ? "Online" : snap?.error ?? "Offline"} />}
              <div className="ic">{item.icon ? <Icon icon={item.icon} iconRef={item.iconRef} name={item.name} size={30} /> : initials(item.name)}</div>
              <div className="n">{item.name}</div>
              {item.note && <div className="s">{item.note}</div>}
            </a>
          );
        })}
      </div>
      {q && shown.length === 0 && <div className="empty-note">No apps match “{query}”.</div>}
    </>
  );
}
