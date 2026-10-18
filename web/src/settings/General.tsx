import { useEffect, useState } from "react";
import { api } from "../api";
import { Confirm } from "../widgets/common";
import { timeZones, useSettings } from "../settings";
import type { IntegrationInfo } from "../types";
import { Row, Section, bytes, useNotice, useSaveSettings } from "./ui";

export const ACCENTS = ["#6c8cff", "#3ecf8e", "#f5a524", "#f0616d", "#c04bff", "#35c5f4"];
export interface DevicePrefs { theme: string; setTheme: (v: string) => void; accent: string; setAccent: (v: string) => void; kiosk: boolean; setKiosk: (on: boolean) => void }
interface Stats { dbBytes: number; metricsRows: number; oldestMetric: number | null; eventRows: number }

function Swatches({ value, onPick, allowNone }: { value: string; onPick: (hex: string) => void; allowNone?: boolean }) {
  return (
    <span className="sw" role="group" aria-label="Accent colour">
      {allowNone && <b className={`none${value === "" ? " on" : ""}`} title="Same as the dashboard" onClick={() => onPick("")}>⌀</b>}
      {ACCENTS.map(c => <b key={c} className={c === value ? "on" : ""} style={{ background: c }} title={c} onClick={() => onPick(c)} />)}
      <input type="color" aria-label="Custom colour" value={/^#[0-9a-f]{6}$/i.test(value) ? value : "#6c8cff"} onChange={e => onPick(e.target.value)} />
    </span>
  );
}

export function General({ device, integrations }: { device: DevicePrefs; integrations: IntegrationInfo[] }) {
  const { settings } = useSettings();
  const s = useSaveSettings();
  const [name, setName] = useState(settings.name);
  const [tz, setTz] = useState(settings.timezone);
  const [url, setUrl] = useState(settings.publicBaseUrl);
  useEffect(() => { setName(settings.name); setTz(settings.timezone); setUrl(settings.publicBaseUrl); }, [settings]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [which, setWhich] = useState("");
  const h = useNotice();
  const loadStats = () => api.get<Stats>("/api/data/stats").then(setStats).catch(() => {});
  useEffect(() => { void loadStats(); }, []);
  const preview = (() => { try { return new Date().toLocaleString([], { timeZone: tz, dateStyle: "medium", timeStyle: "short" }); } catch { return "not a valid time zone"; } })();

  return (
    <>
      <Section title="Dashboard" hint="These apply to everyone who looks at this dashboard.">
        <Row label="Name" hint="Shown at the top left."><input value={name} maxLength={40} onChange={e => setName(e.target.value)} onBlur={() => name.trim() && name !== settings.name && void s.save({ name: name.trim() })} /></Row>
        <Row label="Time zone" hint={`Used by the clock, the media calendar and the log. It is ${preview} there now.`}>
          <input list="zones" value={tz} onChange={e => setTz(e.target.value)} onBlur={() => tz !== settings.timezone && void s.save({ timezone: tz.trim() }).then(() => undefined)} />
          <datalist id="zones">{timeZones().map(z => <option key={z} value={z} />)}</datalist>
        </Row>
        <Row label="Clock"><select value={settings.clock} onChange={e => void s.save({ clock: e.target.value as any })}><option value="auto">Follow the device's language</option><option value="12">12-hour</option><option value="24">24-hour</option></select></Row>
        <Row label="Week starts on"><select value={settings.weekStart} onChange={e => void s.save({ weekStart: e.target.value as any })}><option value="sun">Sunday</option><option value="mon">Monday</option></select></Row>
        <Row label="Public address" hint="Where shared camera links open from outside your home, for example https://cams.example.com. Leave empty if nothing is shared outside."><input value={url} placeholder="https://" onChange={e => setUrl(e.target.value)} onBlur={() => url !== settings.publicBaseUrl && void s.save({ publicBaseUrl: url.trim() })} /></Row>
        {s.el}
      </Section>

      <Section title="Appearance" hint="Choose the look everyone gets by default. Each screen can keep its own choice, which is handy for a wall display.">
        <Row label="Dashboard theme"><select value={settings.theme} onChange={e => void s.save({ theme: e.target.value as any })}><option value="dark">Dark</option><option value="light">Light</option><option value="glass">Glass</option><option value="auto">Follow the device (light or dark)</option></select></Row>
        <Row label="Dashboard accent colour"><Swatches value={settings.accent} onPick={hex => void s.save({ accent: hex })} /></Row>
        <Row label="This device: theme"><select value={device.theme} onChange={e => device.setTheme(e.target.value)}><option value="">Same as the dashboard</option><option value="dark">Dark</option><option value="light">Light</option><option value="glass">Glass</option><option value="auto">Follow the device</option></select></Row>
        <Row label="This device: accent"><Swatches value={device.accent} allowNone onPick={device.setAccent} /></Row>
      </Section>

      <Section title="Wall display" hint="For a tablet or TV that just shows the dashboard: no header, no editing, the screen stays awake, and the page reloads itself after an update.">
        <Row label="Wall display on this device" hint="Or open the dashboard with ?kiosk=1 on the end of its address."><label className="check"><input type="checkbox" checked={device.kiosk} onChange={e => device.setKiosk(e.target.checked)} /> Use wall display mode here</label></Row>
        <Row label="Cycle through tabs" hint="Moves to the next tab on its own while in wall display mode."><select value={settings.kioskCycleSeconds} onChange={e => void s.save({ kioskCycleSeconds: Number(e.target.value) })}>{[[0, "Off"], [10, "Every 10 seconds"], [20, "Every 20 seconds"], [30, "Every 30 seconds"], [60, "Every minute"], [120, "Every 2 minutes"], [300, "Every 5 minutes"]].map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></Row>
      </Section>

      <Section title="History" hint="Graphs on tiles use the stored readings. Keeping more history uses more disk space.">
        <Row label="Keep graph history for"><select value={settings.metricsDays} onChange={e => void s.save({ metricsDays: Number(e.target.value) })}>{[[3, "3 days"], [7, "7 days"], [14, "14 days"], [30, "30 days"], [90, "90 days"], [180, "6 months"], [365, "1 year"]].map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></Row>
        <Row label="Keep the log for"><select value={settings.logDays} onChange={e => void s.save({ logDays: Number(e.target.value) })}>{[[7, "7 days"], [30, "30 days"], [90, "90 days"], [180, "6 months"], [365, "1 year"]].map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></Row>
        {stats && <Row label="Stored now"><span className="sub">{bytes(stats.dbBytes)} database · {stats.metricsRows.toLocaleString()} readings{stats.oldestMetric ? ` (oldest ${new Date(stats.oldestMetric).toLocaleDateString([], { timeZone: settings.timezone })})` : ""} · {stats.eventRows.toLocaleString()} log lines</span></Row>}
        <Row label="Tidy up">
          <span className="row wrapme">
            <button className="btn sm" onClick={async () => { try { const r = await api.post<{ metrics: number; events: number }>("/api/data/prune"); h.ok(`Removed ${r.metrics.toLocaleString()} old readings and ${r.events.toLocaleString()} old log lines.`); void loadStats(); } catch (e) { h.bad(e); } }}>Remove history older than these limits now</button>
            <select value={which} onChange={e => setWhich(e.target.value)} aria-label="Connection"><option value="">All connections</option>{integrations.map(i => <option key={i.id} value={i.id}>{i.name}</option>)}</select>
            <Confirm label="Clear graph history" name="Clear graph history" sure="Click again to clear" onGo={async () => { try { await api.post("/api/data/clear-metrics", { id: which || undefined }); h.ok("Graph history cleared."); void loadStats(); } catch (e) { h.bad(e); } }} />
          </span>
        </Row>
        {h.el}
      </Section>
    </>
  );
}
