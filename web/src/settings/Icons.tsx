import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import { useSettings } from "../settings";
import type { IconStatus, IconTier } from "../types";
import { Row, Section, ago, bytes, useNotice, useSaveSettings } from "./ui";

export const TIERS: Array<{ id: IconTier; name: string; size: string; text: string; best?: boolean }> = [
  { id: "search", name: "Search only", size: "about 5 MB", text: "Keeps only the searchable list of names. Pictures are fetched each time you look at them." },
  { id: "cached", name: "Search and local cache", size: "up to about 200 MB", text: "The list, plus a cache of pictures you have looked at so browsing is quick.", best: true },
  { id: "mirror-single", name: "Mirror, one format", size: "about 350 MB", text: "Downloads every icon once, in its best format, so searching works fully offline." },
  { id: "mirror-full", name: "Mirror, every format", size: "about 1.1 GB", text: "Downloads every icon in every format (SVG, PNG and WebP)." }
];

/** Pick how much of the icon libraries to keep. Used here and as the one-time gate inside the picker. */
export function TierChooser({ value, reviewed, onDone }: { value: IconTier; reviewed: boolean; onDone?: () => void }) {
  const s = useSaveSettings();
  const [pick, setPick] = useState<IconTier>(value);
  return (
    <div className="tiers">
      <div className="tier-grid" role="radiogroup" aria-label="Icon library storage">
        {TIERS.map(t => (
          <button key={t.id} type="button" role="radio" aria-checked={pick === t.id} className={`tier ${pick === t.id ? "on" : ""}`} onClick={() => setPick(t.id)}>
            <b>{t.name}{t.best && <em>Recommended</em>}</b><span className="sz">{t.size}</span><small>{t.text}</small>
          </button>
        ))}
      </div>
      <p className="sub">Homebase downloads icon lists from Dashboard Icons, selfh.st and Lucide on GitHub and npm. Nothing is contacted until you confirm this choice. Icons you actually use are always saved on your server, whichever option you pick.</p>
      <div className="acts"><span>{s.el}</span><span className="acts-right"><button type="button" className="btn pri" disabled={reviewed && pick === value} onClick={async () => { await s.save({ iconTier: pick }); onDone?.(); }}>{reviewed ? "Change" : "Confirm and start"}</button></span></div>
    </div>
  );
}

interface UpdateItem { key: string; kindName: string; name: string; iconRef: string }

export function IconsSettings() {
  const { settings } = useSettings();
  const n = useNotice();
  const [st, setSt] = useState<IconStatus | null>(null);
  const [ups, setUps] = useState<UpdateItem[]>([]);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    try { setSt(await api.get<IconStatus>("/api/icons/status")); setUps((await api.get<{ items: UpdateItem[] }>("/api/icons/updates")).items); } catch (e) { n.bad(e); }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { void load(); }, [load, settings.iconTier]);
  const working = st?.sources.some(x => x.status === "running" || x.status === "queued");
  useEffect(() => { if (!working) return; const t = window.setInterval(() => void load(), 2500); return () => window.clearInterval(t); }, [working, load]);
  const run = async (fn: () => Promise<string | void>) => { setBusy(true); n.clear(); try { const t = await fn(); if (t) n.ok(t); await load(); } catch (e) { n.bad(e); } setBusy(false); };

  return (
    <>
      <Section title="Icon libraries" hint="Icons for connections, tabs, tiles, cameras, people and the Launcher come from three public collections: Dashboard Icons, selfh.st and Lucide. You can also upload your own or use an image address.">
        {st && !st.reviewed && <p className="warnbox">Choose how much to keep before searching the libraries. Nothing is downloaded until you do.</p>}
        <TierChooser value={st?.tier ?? settings.iconTier} reviewed={Boolean(st?.reviewed)} onDone={() => void load()} />
      </Section>
      {st?.reviewed && (
        <Section title="Library status" hint="The list refreshes by itself about once a day.">
          {st.sources.map(s => (
            <Row key={s.id} label={s.name} hint={s.status === "error" ? <span className="error">{s.error}</span> : s.indexAt ? `${s.indexed.toLocaleString()} icons · updated ${ago(s.indexAt)}${s.mirrored ? ` · ${s.mirrored.toLocaleString()} on this server` : ""}${s.removed ? ` · ${s.removed} removed upstream` : ""}` : "Not downloaded yet"}>
              {s.status === "running" || s.status === "queued" ? <span className="sub">Building the library… {s.progress ? `${Math.round(s.progress * 100)}%` : ""}</span>
                : <button className="btn sm" disabled={busy} onClick={() => void run(async () => { await api.post(`/api/icons/sync/${s.id}`); return `Refreshing ${s.name}`; })}>Sync now</button>}
            </Row>
          ))}
          <Row label="Storage used" hint="Saved icons are the copies your tabs and tiles use. Previews and the mirror can be rebuilt at any time.">
            <span className="sub">Saved {bytes(st.sizes.used)} · previews {bytes(st.sizes.cache)} · mirror {bytes(st.sizes.mirror)}</span>
            <button className="btn sm" disabled={busy || !st.sizes.cache} onClick={() => void run(async () => { await api.post("/api/icons/clear-cache"); return "Previews cleared"; })}>Clear previews</button>
          </Row>
          {n.el}
        </Section>
      )}
      {st?.reviewed && (
        <Section title="Updated icons" hint="Saved icons never change by themselves. When a library publishes a new picture for one you use, it shows up here and you decide.">
          <Row label="Check now" hint="Looks up each library icon you use (one small request each).">
            <button className="btn" disabled={busy} onClick={() => void run(async () => { const r = await api.post<{ count: number }>("/api/icons/check"); return r.count ? `${r.count} icon(s) have a newer version` : "Everything is up to date"; })}>Check icons in use</button>
          </Row>
          {ups.length > 0 && (
            <>
              <div className="list">{ups.map(u => <div key={u.key} className="li"><span>{u.kindName}: {u.name}</span><span className="sub">{u.iconRef}</span><button className="btn sm" disabled={busy} onClick={() => void run(async () => { await api.post("/api/icons/refresh", { keys: [u.key] }); return "Updated"; })}>Update</button></div>)}</div>
              <div className="acts"><span /><span className="acts-right"><button className="btn pri" disabled={busy} onClick={() => void run(async () => { const r = await api.post<{ refreshed: number }>("/api/icons/refresh"); return `Updated ${r.refreshed} icon(s). Reload the page to see them everywhere.`; })}>Update all</button></span></div>
            </>
          )}
        </Section>
      )}
    </>
  );
}
