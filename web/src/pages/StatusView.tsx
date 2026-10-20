import { useEffect, useState } from "react";
import { api } from "../api";
import { DayBars, StateDot, STATE_LABEL, fmtMs, fmtPct, groupRows, groupState } from "../components/MonitorBits";
import type { PublicMaintenance, PublicStatus } from "../types";

const HEADLINE: Record<PublicStatus["overall"], string> = { up: "All systems operational", degraded: "Some systems are down", down: "Major outage", maintenance: "Scheduled maintenance", unknown: "Waiting for the first checks" };
const STYLE_LABEL = { info: "Notice", warn: "Warning", bad: "Outage", ok: "Good news" };
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const when = (w: PublicMaintenance, tz: string) => {
  const fmt = (ms: number) => new Date(ms).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  if (w.kind === "once") return `${fmt(w.startsAt ?? 0)} to ${fmt(w.endsAt ?? 0)}`;
  return `${w.kind === "daily" ? "Every day" : w.days.map(d => DAYS[d]).join(", ")} at ${w.startTime} (${tz}) for ${w.durationMin >= 60 ? `${Math.round(w.durationMin / 6) / 10} h` : `${w.durationMin} min`}`;
};

/** What someone sees at a status page link (or at a status page's own domain): names, whether each is up, uptime, response time, posts and planned work. Nothing else. */
export function StatusView({ token }: { token: string }) {
  const [data, setData] = useState<PublicStatus | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    const load = async () => {
      try { const r = await api.get<PublicStatus>(`/api/status/${token}`); if (live) { setData(r); setError(""); } }
      catch (e) { if (live) setError(e instanceof Error ? e.message : "This status page is not available."); }
    };
    void load();
    const t = window.setInterval(() => { if (!document.hidden) void load(); }, 30_000);
    return () => { live = false; window.clearInterval(t); };
  }, [token]);
  useEffect(() => { document.title = data?.title ?? "Status"; }, [data]);

  if (error && !data) return <div className="signin"><div className="signin-card"><div className="logo big"><i />Status</div><p className="error">{error}</p></div></div>;
  if (!data) return <div className="boot">Loading…</div>;
  const open = data.incidents.filter(i => !i.resolved), past = data.incidents.filter(i => i.resolved);
  return (
    <div className="statusview">
      <header className="statushead">
        <h1>{data.title}</h1>
        {data.message && <p className={`statusnote ${data.tone ?? "info"}`}>{data.message}</p>}
        <div className={`statusbanner ${data.overall}`} role="status">{HEADLINE[data.overall]}</div>
      </header>
      {open.map(i => (
        <section key={i.id} className={`statusnote post ${i.style}`}>
          <div className="row sp wrapme"><b>{i.title}</b><span className="sub">{STYLE_LABEL[i.style]} · {i.updatedAt > i.createdAt + 1000 ? "updated" : "posted"} {new Date(i.updatedAt).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</span></div>
          {i.body && <p>{i.body}</p>}
        </section>
      ))}
      {data.maintenance.length > 0 && (
        <section className="statusgroup">
          <h2>Planned maintenance</h2>
          {data.maintenance.map((w, i) => (
            <div key={i} className="statuscard row sp wrapme"><span className="row g8"><StateDot state={w.active ? "maintenance" : "paused"} /><b>{w.title}</b></span><span className="sub">{w.active ? "Happening now · " : ""}{when(w, data.timezone)}</span></div>
          ))}
        </section>
      )}
      <div className="statuslist">
        {groupRows(data.monitors).map(g => (
          <section key={g.name || "_"} className="statusgroup">
            {(g.name || data.monitors.some(m => m.group)) && <div className="row g8"><StateDot state={groupState(g.rows)} /><h2>{g.name || "Other"}</h2></div>}
            {g.rows.map((m, i) => (
              <div key={i} className="statuscard">
                <div className="row sp wrapme"><span className="row g8"><StateDot state={m.state} /><b>{m.name}</b></span><span className="sub">{STATE_LABEL[m.state]}{m.ms !== null && m.state === "up" ? ` · ${fmtMs(m.ms)}` : ""}</span></div>
                <DayBars days={m.days} />
                <div className="row sp sub"><span>{m.days.length} days ago</span><span>{fmtPct(m.uptime30d)} uptime over 30 days</span><span>Today</span></div>
              </div>
            ))}
          </section>
        ))}
      </div>
      {past.length > 0 && (
        <section className="statusgroup">
          <h2>Recent notices</h2>
          {past.map(i => (
            <div key={i.id} className="statuscard"><div className="row sp wrapme"><b>{i.title}</b><span className="sub">Resolved {new Date(i.updatedAt).toLocaleDateString([], { month: "short", day: "numeric" })}</span></div>{i.body && <p className="sub">{i.body}</p>}</div>
          ))}
        </section>
      )}
      <footer className="sub statusfoot">Updated {new Date(data.updatedAt).toLocaleTimeString()}. This page refreshes by itself. <a href={`/api/status/${token}/rss`}>RSS</a></footer>
    </div>
  );
}
