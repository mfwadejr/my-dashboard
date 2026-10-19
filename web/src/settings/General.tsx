import { useEffect, useState } from "react";
import { timeZones, useSettings } from "../settings";
import type { IntegrationInfo } from "../types";
import { Row, Section, useSaveSettings } from "./ui";

/** The preset accent colours live in the site-wide CSS (--accent-1 .. --accent-6); this reads them from there. */
const presetAccents = (): string[] => {
  const cs = getComputedStyle(document.documentElement);
  return [1, 2, 3, 4, 5, 6].map(i => cs.getPropertyValue(`--accent-${i}`).trim().toLowerCase());
};
export interface DevicePrefs { theme: string; setTheme: (v: string) => void; accent: string; setAccent: (v: string) => void; kiosk: boolean; setKiosk: (on: boolean) => void }

function Swatches({ value, onPick, allowNone }: { value: string; onPick: (hex: string) => void; allowNone?: boolean }) {
  const presets = presetAccents();
  return (
    <span className="sw" role="group" aria-label="Accent colour">
      {allowNone && <b className={`none${value === "" ? " on" : ""}`} title="Same as the dashboard" onClick={() => onPick("")}>⌀</b>}
      {presets.map((c, i) => <b key={i} className={`p${i + 1}${c === value.toLowerCase() ? " on" : ""}`} title={c} onClick={() => onPick(c)} />)}
      <input type="color" aria-label="Custom colour" value={/^#[0-9a-f]{6}$/i.test(value) ? value : presets[0]} onChange={e => onPick(e.target.value)} />
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
  const preview = (() => { try { return new Date().toLocaleString([], { timeZone: tz, dateStyle: "medium", timeStyle: "short" }); } catch { return "not a valid time zone"; } })();

  return (
    <>
      <Section title="Dashboard" hint="These apply to everyone who looks at this dashboard.">
        <Row label="Name" hint="Shown at the top left."><input value={name} maxLength={40} onChange={e => setName(e.target.value)} onBlur={() => name.trim() && name !== settings.name && void s.save({ name: name.trim() })} /></Row>
        <Row label="Time zone" hint={`Used by the clock, the media calendar and the log. It is ${preview} there now.`}>
          <select value={tz} onChange={e => { setTz(e.target.value); void s.save({ timezone: e.target.value }); }}>
            {(timeZones().includes(tz) ? timeZones() : [tz, ...timeZones()]).map(z => <option key={z} value={z}>{z}</option>)}
          </select>
        </Row>
        <Row label="Clock"><select value={settings.clock} onChange={e => void s.save({ clock: e.target.value as any })}><option value="auto">Follow the device's language</option><option value="12">12-hour</option><option value="24">24-hour</option></select></Row>
        <Row label="Week starts on"><select value={settings.weekStart} onChange={e => void s.save({ weekStart: e.target.value as any })}><option value="sun">Sunday</option><option value="mon">Monday</option></select></Row>
        <Row label="Public address" hint="Where shared camera links open from outside your home, for example https://cams.example.com. Leave empty if nothing is shared outside."><input value={url} placeholder="https://" onChange={e => setUrl(e.target.value)} onBlur={() => url !== settings.publicBaseUrl && void s.save({ publicBaseUrl: url.trim() })} /></Row>
        {s.el}
      </Section>

      <Section title="Appearance" hint="Choose the look everyone gets by default. Your own theme and accent colour are saved to your account and follow you to every screen you sign in on.">
        <Row label="Dashboard theme"><select value={settings.theme} onChange={e => void s.save({ theme: e.target.value as any })}><option value="dark">Dark</option><option value="light">Light</option><option value="glass">Glass</option><option value="auto">Follow the device (light or dark)</option></select></Row>
        <Row label="Dashboard accent colour"><Swatches value={settings.accent} onPick={hex => void s.save({ accent: hex })} /></Row>
        <Row label="My theme"><select value={device.theme} onChange={e => device.setTheme(e.target.value)}><option value="">Same as the dashboard</option><option value="dark">Dark</option><option value="light">Light</option><option value="glass">Glass</option><option value="auto">Follow the device</option></select></Row>
        <Row label="My accent colour"><Swatches value={device.accent} allowNone onPick={device.setAccent} /></Row>
      </Section>

      <Section title="Wall display" hint="For a tablet or TV that just shows the dashboard: no header, no editing, the screen stays awake, and the page reloads itself after an update.">
        <Row label="Wall display on this device" hint="Or open the dashboard with ?kiosk=1 on the end of its address."><label className="check"><input type="checkbox" checked={device.kiosk} onChange={e => device.setKiosk(e.target.checked)} /> Use wall display mode here</label></Row>
        <Row label="Cycle through tabs" hint="Moves to the next tab on its own while in wall display mode."><select value={settings.kioskCycleSeconds} onChange={e => void s.save({ kioskCycleSeconds: Number(e.target.value) })}>{[[0, "Off"], [10, "Every 10 seconds"], [20, "Every 20 seconds"], [30, "Every 30 seconds"], [60, "Every minute"], [120, "Every 2 minutes"], [300, "Every 5 minutes"]].map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></Row>
      </Section>
    </>
  );
}
