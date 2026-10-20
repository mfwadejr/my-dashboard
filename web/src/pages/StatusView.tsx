import { useEffect, useState } from "react";
import { api } from "../api";
import { DayBars, StateDot, STATE_LABEL, fmtMs, fmtPct, groupRows, groupState } from "../components/MonitorBits";
import type { PublicStatus } from "../types";

const HEADLINE: Record<PublicStatus["overall"], string> = { up: "All systems operational", degraded: "Some systems are down", down: "Major outage", maintenance: "Scheduled maintenance", unknown: "Waiting for the first checks" };

/** What someone sees at a status page link: names, whether each is up, uptime and response time. Nothing else. */
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
  return (
    <div className="statusview">
      <header className="statushead">
        <h1>{data.title}</h1>
        {data.message && <p className={`statusnote ${data.tone ?? "info"}`}>{data.message}</p>}
        <div className={`statusbanner ${data.overall}`} role="status">{HEADLINE[data.overall]}</div>
      </header>
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
      <footer className="sub statusfoot">Updated {new Date(data.updatedAt).toLocaleTimeString()}. This page refreshes by itself.</footer>
    </div>
  );
}
