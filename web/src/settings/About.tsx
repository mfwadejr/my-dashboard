import { useEffect, useState } from "react";
import { api } from "../api";
import { Pill } from "../widgets/common";
import { useSettings, fmtDateTime } from "../settings";
import type { AboutInfo } from "../types";
import { Row, Section, ago, useNotice, useSaveSettings } from "./ui";

interface UpdateInfo { ts: number; running: string; latest: string; aheadBy: number; upToDate: boolean; error: string | null; commits: Array<{ sha: string; message: string; date: string }>; repo: string }

function Updates() {
  const { settings } = useSettings();
  const s = useSaveSettings(), n = useNotice();
  const [info, setInfo] = useState<UpdateInfo | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { void api.get<{ info: UpdateInfo | null }>("/api/update").then(r => setInfo(r.info)).catch(() => {}); }, []);
  const check = async () => { n.clear(); setBusy(true); try { setInfo(await api.post<UpdateInfo>("/api/update/check")); } catch (e) { n.bad(e); } setBusy(false); };
  return (
    <Section title="Updates" hint="Off by default, so Homebase never contacts anything on its own. When on, it asks GitHub once a day how far this build is behind the main branch. The request carries only the code of the commit this build was made from.">
      <Row label="Check for updates"><label className="check"><input type="checkbox" checked={settings.updateCheck} onChange={e => void s.save({ updateCheck: e.target.checked })} /> Check GitHub once a day</label></Row>
      {settings.updateCheck && <Row label="Check now"><button className="btn" disabled={busy} onClick={() => void check()}>{busy ? "Checking…" : "Check now"}</button></Row>}
      {settings.updateCheck && info && (
        <Row label="Result" hint={`Checked ${ago(info.ts)}`}>
          {info.error ? <span className="error">{info.error}</span> : info.upToDate ? <Pill tone="ok">Up to date</Pill> : (
            <div><Pill tone="warn">{info.aheadBy} newer change(s)</Pill> Pull the new image to get them.<ul className="sub">{info.commits.map(c => <li key={c.sha}><code>{c.sha}</code> {c.message}</li>)}</ul></div>
          )}
        </Row>
      )}
      {s.el}{n.el}
    </Section>
  );
}

export function About({ about }: { about: AboutInfo | null }) {
  const { settings } = useSettings();
  return (
    <>
    <Section title="About this install" hint="Handy when you are updating: after you pull a new image, the commit here should change.">
      {!about ? <p className="sub">Loading…</p> : (
        <>
          <Row label="Version"><b>{about.version}</b></Row>
          <Row label="Build" hint="The short code of the change this image was made from."><code>{about.commit}</code></Row>
          <Row label="Built">{about.built ? new Date(about.built).toLocaleString([], { timeZone: settings.timezone }) : <span className="sub">Not recorded (a local build)</span>}</Row>
          <Row label="Started">{fmtDateTime(about.startedAt, settings)}</Row>
          <Row label="Runs on">Node {about.node.replace(/^v/, "")}</Row>
          <Row label="Camera relay">{about.go2rtc ? "Connected to go2rtc" : "Not set up"}</Row>
          <Row label="Sharing port">{about.publicPort ?? "Off"}</Row>
          <Row label="Source"><a href="https://github.com/mfwadejr/my-dashboard" target="_blank" rel="noreferrer">github.com/mfwadejr/my-dashboard</a></Row>
        </>
      )}
    </Section>
    <Updates />
    </>
  );
}
