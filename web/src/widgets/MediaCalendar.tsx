import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../api";
import { usePref } from "../hooks";
import type { WidgetProps } from "./types";
import { Empty, Pill, Title, useTick } from "./common";
import { NeedsConnection } from "./Arr";

interface Entry {
  key: string; source: "sonarr" | "radarr"; integrationId: string; title: string; subtitle: string; date: string; allDay: boolean;
  state: "downloaded" | "downloading" | "missing" | "upcoming" | "released"; releaseType: string | null; poster: string | null; overview: string | null;
}
interface Result { entries: Entry[]; errors: Array<{ integrationId: string; name: string; error: string }>; sources: Array<{ id: string; name: string; type: string }> }

const pad = (n: number) => String(n).padStart(2, "0");
const dayKey = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
/** Radarr dates are whole days (no time), so they must not shift with the viewer's time zone. Sonarr air times are real moments. */
const entryDay = (e: Entry) => (e.allDay ? e.date.slice(0, 10) : dayKey(new Date(e.date)));
const TONE: Record<Entry["state"], "ok" | "warn" | "bad" | "mute"> = { downloaded: "ok", downloading: "warn", missing: "bad", upcoming: "mute", released: "mute" };
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function timeOf(e: Entry): string {
  if (e.allDay) return e.releaseType ?? "";
  return new Date(e.date).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function EntryRow({ e }: { e: Entry }) {
  return (
    <div className="mc-entry" title={e.overview ?? undefined}>
      {e.poster ? <img className="mc-poster" src={e.poster} alt="" loading="lazy" /> : <div className="mc-poster none">{e.source === "sonarr" ? "TV" : "🎬"}</div>}
      <div className="mc-info">
        <div className="trunc"><b>{e.title}</b></div>
        <div className="sub trunc">{[e.subtitle, timeOf(e)].filter(Boolean).join(" · ")}</div>
      </div>
      <Pill tone={TONE[e.state]}>{e.state}</Pill>
    </div>
  );
}

export function MediaCalendar(props: WidgetProps) {
  const cfg = props.tile.config;
  const ids = useMemo(() => ((cfg.integrationIds ?? []) as string[]).filter(id => props.integrations.some(i => i.id === id)), [cfg.integrationIds, props.integrations]);
  const release = String(cfg.release ?? "digital");
  const weekStart = cfg.weekStart === "mon" ? 1 : 0;
  const [view, setView] = usePref<"month" | "list">("hb_cal_view", "month");
  const [cursor, setCursor] = useState(() => { const n = new Date(); return new Date(n.getFullYear(), n.getMonth(), 1); });
  const [picked, setPicked] = useState<string>(() => dayKey(new Date()));
  const [data, setData] = useState<Result | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Six full weeks starting on the chosen weekday: always the same grid height.
  const gridStart = useMemo(() => {
    const first = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
    return new Date(first.getFullYear(), first.getMonth(), 1 - ((first.getDay() - weekStart + 7) % 7));
  }, [cursor, weekStart]);
  const cells = useMemo(() => Array.from({ length: 42 }, (_, i) => new Date(gridStart.getFullYear(), gridStart.getMonth(), gridStart.getDate() + i)), [gridStart]);

  const idKey = ids.join(",");
  const load = useCallback(async () => {
    if (!idKey) return;
    // Pad by a day each side so a time-zone shift never drops an edge day.
    const start = new Date(cells[0].getTime() - 86400_000), end = new Date(cells[41].getTime() + 2 * 86400_000);
    try {
      setData(await api.get<Result>(`/api/calendar?ids=${idKey}&start=${encodeURIComponent(start.toISOString())}&end=${encodeURIComponent(end.toISOString())}&release=${release}`));
      setError(null);
    } catch (e) { setError(e instanceof Error ? e.message : "Could not load the calendar"); }
  }, [idKey, release, cells]);
  useEffect(() => { void load(); }, [load]);
  useTick(5 * 60_000, () => { if (!document.hidden) void load(); });

  if (!ids.length) return <NeedsConnection label="Media calendar" editing={props.editing} openSettings={props.openSettings} missing={Boolean((cfg.integrationIds as string[] | undefined)?.length)} />;

  const byDay = new Map<string, Entry[]>();
  for (const e of data?.entries ?? []) { const k = entryDay(e); (byDay.get(k) ?? byDay.set(k, []).get(k)!).push(e); }
  const today = dayKey(new Date());
  const small = props.tile.h < 4;
  const names = DAYS.map((_, i) => DAYS[(i + weekStart) % 7]);
  const monthKey = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
  const shown = monthKey(cursor);
  const listDays = [...byDay.keys()].filter(k => k.startsWith(shown)).sort();
  const move = (d: number) => { const n = new Date(cursor.getFullYear(), cursor.getMonth() + d, 1); setCursor(n); };
  const goToday = () => { const n = new Date(); setCursor(new Date(n.getFullYear(), n.getMonth(), 1)); setPicked(dayKey(n)); };
  const dayList = byDay.get(picked) ?? [];
  const pickedDate = new Date(`${picked}T12:00:00`);

  return (
    <>
      <Title right={
        <span className="row" style={{ gap: 4 }}>
          <button type="button" className="btn sm" aria-label="Previous month" onClick={() => move(-1)}>‹</button>
          <button type="button" className="btn sm" onClick={goToday}>Today</button>
          <button type="button" className="btn sm" aria-label="Next month" onClick={() => move(1)}>›</button>
          <button type="button" className="btn sm" aria-label="Switch view" title={view === "month" ? "Show as a list" : "Show as a month"} onClick={() => setView(view === "month" ? "list" : "month")}>{view === "month" ? "☰" : "▦"}</button>
        </span>
      }>{String(cfg.title || `${MONTHS[cursor.getMonth()]} ${cursor.getFullYear()}`)}</Title>
      {error && <div className="stale-note" role="alert">{error}</div>}
      {data?.errors.map(er => <div key={er.integrationId} className="stale-note" title={er.error}>{er.name}: could not load</div>)}
      {!data && !error && <Empty>Loading…</Empty>}
      {data && view === "month" && (
        <>
          <div className="mc-grid" role="grid">
            {names.map(n => <div key={n} className="mc-h">{n}</div>)}
            {cells.map(d => {
              const k = dayKey(d), list = byDay.get(k) ?? [];
              const tv = list.filter(e => e.source === "sonarr"), mv = list.filter(e => e.source === "radarr");
              return (
                <button key={k} type="button" className={`mc-d${monthKey(d) !== shown ? " out" : ""}${k === today ? " today" : ""}${k === picked ? " sel" : ""}`}
                  onClick={() => setPicked(k)} aria-label={`${d.toDateString()}, ${list.length} item${list.length === 1 ? "" : "s"}`}>
                  <span>{d.getDate()}</span>
                  <span className="mc-dots">
                    {tv.length > 0 && <i className={`tv${tv.every(e => e.state === "downloaded") ? " full" : ""}`} />}
                    {mv.length > 0 && <i className={`mv${mv.every(e => e.state === "downloaded") ? " full" : ""}`} />}
                  </span>
                </button>
              );
            })}
          </div>
          {!small && (
            <div className="mc-day">
              <div className="sub">{pickedDate.toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" })}</div>
              {dayList.length === 0 ? <div className="sub">Nothing scheduled</div> : <div className="list">{dayList.map(e => <EntryRow key={e.key} e={e} />)}</div>}
            </div>
          )}
          {small && dayList.length > 0 && <div className="sub">{dayList.length} on {pickedDate.toLocaleDateString([], { month: "short", day: "numeric" })}: {dayList.map(e => e.title).join(", ")}</div>}
          <div className="mc-key sub"><i className="tv full" /> TV <i className="mv full" /> Movies · filled = downloaded</div>
        </>
      )}
      {data && view === "list" && (
        listDays.length === 0 ? <Empty>Nothing scheduled this month</Empty> : (
          <div className="mc-list">
            {listDays.map(k => (
              <div key={k}>
                <div className="sub mc-lh">{new Date(`${k}T12:00:00`).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" })}{k === today ? " · today" : ""}</div>
                <div className="list">{byDay.get(k)!.map(e => <EntryRow key={e.key} e={e} />)}</div>
              </div>
            ))}
          </div>
        )
      )}
    </>
  );
}
