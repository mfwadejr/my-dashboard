import { useEffect, useState } from "react";
import { api } from "../api";
import { Pill } from "../widgets/common";
import { fmtDateTime, useSettings } from "../settings";
import { Row, Section, ago, bytes, useNotice, useSaveSettings } from "./ui";

interface Disk { total: number; free: number; freePct: number; level: "ok" | "low" | "critical" }
interface Last { ts: number; manual: boolean; ok: boolean; ms: number; integrity: string; foreignKeyProblems: number; bytesBefore: number; bytesAfter: number; message: string }
interface Info { last: Last | null; tables: Array<{ name: string; bytes: number }>; disk: Disk | null; schedule: "weekly" | "monthly" | "off" }

export function DiskNote({ disk }: { disk: Disk | null | undefined }) {
  if (!disk || disk.level === "ok") return null;
  return <p className="error" role="alert">{disk.level === "critical" ? "The disk is almost full" : "The disk is getting full"}: {bytes(disk.free)} free ({disk.freePct}%). {disk.level === "critical" ? "Homebase may soon be unable to save anything. Free some space now, or lower the history and backup limits." : "Consider lowering the history, log or backup limits."}</p>;
}

/** Tidying the database file, and how much room is left on the disk that holds it. */
export function Maintenance() {
  const { settings } = useSettings();
  const s = useSaveSettings(), n = useNotice();
  const [info, setInfo] = useState<Info | null>(null);
  const [busy, setBusy] = useState(false);
  const load = () => { void api.get<Info>("/api/maintenance").then(setInfo).catch(() => {}); };
  useEffect(load, []);
  const run = async () => {
    n.clear(); setBusy(true);
    try { const r = await api.post<Last>("/api/maintenance/run"); n.ok(r.message); load(); } catch (e) { n.bad(e); }
    setBusy(false);
  };
  const last = info?.last;
  return (
    <Section title="Database upkeep" hint="Checks the database for damage, refreshes the search index and gives back space that deleted history left behind. It takes a few seconds and Homebase keeps running.">
      <DiskNote disk={info?.disk} />
      {info?.disk && <Row label="Disk space"><span className="sub">{bytes(info.disk.free)} free of {bytes(info.disk.total)} ({info.disk.freePct}% free) <Pill tone={info.disk.level === "ok" ? "ok" : info.disk.level === "low" ? "warn" : "bad"}>{info.disk.level === "ok" ? "plenty" : info.disk.level}</Pill></span></Row>}
      <Row label="Run automatically"><select value={settings.maintenance} onChange={e => void s.save({ maintenance: e.target.value as "weekly" | "monthly" | "off" }).then(load)}><option value="weekly">Weekly (Sunday night)</option><option value="monthly">Monthly</option><option value="off">Never</option></select></Row>
      <Row label="Run it now"><button className="btn" disabled={busy} onClick={() => void run()}>{busy ? "Working…" : "Run upkeep now"}</button></Row>
      {last && (
        <Row label="Last run" hint={last.message}>
          <span className="sub">{fmtDateTime(last.ts, settings)} ({ago(last.ts)}) · {last.manual ? "by hand" : "automatic"} · {(last.ms / 1000).toFixed(1)} s · {last.ok ? <Pill tone="ok">healthy</Pill> : <Pill tone="bad">problems found</Pill>} · {bytes(last.bytesBefore)} → {bytes(last.bytesAfter)}</span>
        </Row>
      )}
      {info && info.tables.length > 0 && (
        <Row label="What takes the space"><span className="sub">{info.tables.map(t => `${t.name} ${bytes(t.bytes)}`).join(" · ")}</span></Row>
      )}
      {s.el}{n.el}
    </Section>
  );
}
