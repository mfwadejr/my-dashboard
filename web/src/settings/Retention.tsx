import { useEffect, useState } from "react";
import { api } from "../api";
import { Confirm } from "../widgets/common";
import { fmtDateTime, useSettings } from "../settings";
import type { IntegrationInfo } from "../types";
import { Row, Section, ago, bytes, useNotice, useSaveSettings } from "./ui";

interface Plan { dryRun: boolean; hourly: { from: number; to: number }; daily: { from: number; to: number }; expiredReadings: number; logByAge: number; logBySize: number; archive: string | null; metrics: number; events: number }
interface Stats {
  dbBytes: number; metricsRows: number; oldestMetric: number | null; eventRows: number; logBytes: number;
  readingsByDetail: { detailed: number; hourly: number; daily: number }; lastPrune: (Plan & { ts: number }) | null; archives: { count: number; bytes: number };
}
interface Archive { name: string; size: number; ts: number }

const AREAS: Array<[string, string]> = [["security", "Security (sign-ins)"], ["settings", "Settings changes"], ["connection", "Connections"], ["camera", "Cameras"], ["share", "Sharing"], ["backup", "Backups"], ["system", "System"], ["api", "API tokens"]];
const days = (list: Array<[number, string]>) => list.map(([v, l]) => <option key={v} value={v}>{l}</option>);
const DETAIL: Array<[number, string]> = [[1, "1 day"], [2, "2 days"], [3, "3 days"], [7, "7 days"], [14, "14 days"]];
const HOURLY: Array<[number, string]> = [[7, "7 days"], [14, "14 days"], [30, "30 days"], [60, "60 days"], [90, "90 days"], [180, "6 months"]];
const TOTAL: Array<[number, string]> = [[30, "30 days"], [90, "90 days"], [180, "6 months"], [365, "1 year"], [730, "2 years"], [1825, "5 years"]];
const LOGDAYS: Array<[number, string]> = [[7, "7 days"], [14, "14 days"], [30, "30 days"], [90, "90 days"], [180, "6 months"], [365, "1 year"], [730, "2 years"]];

/** Graph history tiers and log rules, with a preview before anything is removed. */
export function Retention({ integrations }: { integrations: IntegrationInfo[] }) {
  const { settings } = useSettings();
  const s = useSaveSettings(), h = useNotice(), a = useNotice();
  const [stats, setStats] = useState<Stats | null>(null);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [archives, setArchives] = useState<Archive[]>([]);
  const [which, setWhich] = useState("");
  const load = () => { void api.get<Stats>("/api/data/stats").then(setStats).catch(() => {}); void api.get<Archive[]>("/api/logs/archives").then(setArchives).catch(() => {}); };
  useEffect(load, []);
  const save = async (patch: Parameters<typeof s.save>[0]) => { setPlan(null); await s.save(patch); load(); };
  const withOption = (list: Array<[number, string]>, v: number): Array<[number, string]> => (list.some(([x]) => x === v) ? list : [...list, [v, `${v} days`] as [number, string]].sort((x, y) => x[0] - y[0]));

  const preview = async () => { h.clear(); try { setPlan(await api.post<Plan>("/api/data/prune", { dryRun: true })); } catch (e) { h.bad(e); } };
  const apply = async () => {
    h.clear();
    try { const r = await api.post<Plan>("/api/data/prune"); setPlan(null); h.ok(`Done. ${r.metrics.toLocaleString()} graph reading(s) and ${r.events.toLocaleString()} log line(s) removed${r.archive ? `; the old log lines were saved first as ${r.archive}` : ""}.`); load(); }
    catch (e) { h.bad(e); }
  };
  const areaDays = settings.logAreaDays;
  const setArea = (area: string, v: number) => { const next = { ...areaDays }; if (v) next[area] = v; else delete next[area]; void save({ logAreaDays: next }); };

  return (
    <>
      <Section title="Graph history" hint="Tile graphs use stored readings. Recent readings are kept in full detail; older ones are averaged into hourly and then daily points, so you can keep a year or more of trends in a small space. Rules run automatically every hour.">
        <Row label="Full detail for" hint="Every reading, as it was taken."><select value={settings.historyDetailDays} onChange={e => void save({ historyDetailDays: Number(e.target.value) })}>{days(withOption(DETAIL, settings.historyDetailDays))}</select></Row>
        <Row label="Hourly averages until" hint="After the full-detail period, one point per hour."><select value={settings.historyHourlyDays} onChange={e => void save({ historyHourlyDays: Number(e.target.value) })}>{days(withOption(HOURLY, settings.historyHourlyDays))}</select></Row>
        <Row label="Daily averages until" hint="After that, one point per day. Then they are removed."><select value={settings.metricsDays} onChange={e => void save({ metricsDays: Number(e.target.value) })}>{days(withOption(TOTAL, settings.metricsDays))}</select></Row>
        {stats && <Row label="Stored now"><span className="sub">{stats.readingsByDetail.detailed.toLocaleString()} detailed · {stats.readingsByDetail.hourly.toLocaleString()} hourly · {stats.readingsByDetail.daily.toLocaleString()} daily{stats.oldestMetric ? ` (oldest ${new Date(stats.oldestMetric).toLocaleDateString([], { timeZone: settings.timezone })})` : ""}</span></Row>}
        <Row label="Clear graphs" hint="Throws away the stored readings, for one connection or all of them.">
          <span className="row wrapme">
            <select value={which} onChange={e => setWhich(e.target.value)} aria-label="Connection"><option value="">All connections</option>{integrations.map(i => <option key={i.id} value={i.id}>{i.name}</option>)}</select>
            <Confirm label="Clear graph history" name="Clear graph history" sure="Click again to clear" onGo={async () => { try { await api.post("/api/data/clear-metrics", { id: which || undefined }); h.ok("Graph history cleared."); load(); } catch (e) { h.bad(e); } }} />
          </span>
        </Row>
      </Section>

      <Section title="Log" hint="Errors are worth keeping longer than routine information, so each severity has its own limit. Particular areas can be given a shorter limit of their own.">
        <Row label="Information kept for"><select value={settings.logDays} onChange={e => void save({ logDays: Number(e.target.value) })}>{days(withOption(LOGDAYS, settings.logDays))}</select></Row>
        <Row label="Warnings kept for"><select value={settings.logWarnDays} onChange={e => void save({ logWarnDays: Number(e.target.value) })}>{days(withOption(LOGDAYS, settings.logWarnDays))}</select></Row>
        <Row label="Errors kept for"><select value={settings.logErrorDays} onChange={e => void save({ logErrorDays: Number(e.target.value) })}>{days(withOption(LOGDAYS, settings.logErrorDays))}</select></Row>
        <Row label="Size limit" hint="When the log grows past this, the oldest lines go first, whatever their severity."><select value={settings.logMaxMB} onChange={e => void save({ logMaxMB: Number(e.target.value) })}>{[[0, "No limit"], [25, "25 MB"], [50, "50 MB"], [100, "100 MB"], [250, "250 MB"], [500, "500 MB"]].map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></Row>
        <Row label="Shorter limits by area" hint="Optional. For example, keep API token activity for only a week.">
          <span className="areas">{AREAS.map(([id, label]) => (
            <label key={id}><span>{label}</span><select value={areaDays[id] ?? 0} onChange={e => setArea(id, Number(e.target.value))} aria-label={`${label} kept for`}><option value={0}>Same as severity</option>{days(withOption(LOGDAYS.filter(([v]) => v <= 365), areaDays[id] ?? 0).filter(([v]) => v > 0))}</select></label>
          ))}</span>
        </Row>
        <Row label="Save before removing" hint="Writes the lines that are about to be removed to a spreadsheet file (CSV) you can download below. The 24 newest files are kept."><label className="check"><input type="checkbox" checked={settings.logExportBeforePrune} onChange={e => void save({ logExportBeforePrune: e.target.checked })} /> Keep a CSV of removed log lines</label></Row>
        <Row label="How much to record" hint="Quiet: only warnings, errors and security notes. Normal: also routine events and changes. Detailed: adds extra detail lines and lists every API call."><select value={settings.logVerbosity} onChange={e => void save({ logVerbosity: e.target.value as "quiet" | "normal" | "detailed" })}><option value="quiet">Quiet</option><option value="normal">Normal</option><option value="detailed">Detailed</option></select></Row>
        {stats && <Row label="Stored now"><span className="sub">{stats.eventRows.toLocaleString()} log line(s), about {bytes(stats.logBytes)}</span></Row>}
        {s.el}
      </Section>

      <Section title="Apply the rules" hint="They run on their own every hour. To see what they would do right now, preview first; nothing is removed until you apply.">
        <Row label=""><span className="row wrapme"><button className="btn" onClick={() => void preview()}>Preview</button><Confirm label="Apply now" name="Apply the history and log rules" sure="Click again to apply" onGo={apply} /></span></Row>
        {plan && (
          <div className="preview">
            <b>If applied now:</b>
            <ul>
              <li>Graphs: {plan.hourly.from.toLocaleString()} detailed reading(s) become {plan.hourly.to.toLocaleString()} hourly point(s); {plan.daily.from.toLocaleString()} hourly point(s) become {plan.daily.to.toLocaleString()} daily point(s); {plan.expiredReadings.toLocaleString()} reading(s) are past the limit and removed.</li>
              <li>Log: {plan.logByAge.toLocaleString()} line(s) are older than their limit{plan.logBySize ? `; ${plan.logBySize.toLocaleString()} more would go to get under the size limit` : ""}.</li>
              {settings.logExportBeforePrune && <li>The removed log lines would be saved to a CSV file first.</li>}
            </ul>
          </div>
        )}
        {stats?.lastPrune && <Row label="Last run"><span className="sub">{fmtDateTime(stats.lastPrune.ts, settings)} ({ago(stats.lastPrune.ts)}): {stats.lastPrune.metrics.toLocaleString()} reading(s) and {stats.lastPrune.events.toLocaleString()} log line(s) removed</span></Row>}
        {h.el}
      </Section>

      <Section title="Saved log files" hint="Created when “Keep a CSV of removed log lines” is on. Download them, or delete the ones you no longer need.">
        {archives.length === 0 ? <p className="sub">None yet.</p> : (
          <div className="rows">{archives.map(f => (
            <div key={f.name} className="srow"><div><b>{f.name}</b><div className="sub">{fmtDateTime(f.ts, settings)} · {bytes(f.size)}</div></div>
              <span className="row wrapme"><a className="btn sm" href={`/api/logs/archives/${f.name}`} download>Download</a><Confirm label="Delete" name={`Delete ${f.name}`} sure="Sure?" onGo={async () => { a.clear(); try { await api.del(`/api/logs/archives/${f.name}`); load(); } catch (e) { a.bad(e); } }} /></span></div>
          ))}</div>
        )}
        {a.el}
      </Section>
    </>
  );
}
