import { useState } from "react";
import { api } from "../api";
import { Field, Modal } from "../dialogs/Modal";
import type { MonitorConfigInfo } from "../types";

const KINDS = [
  ["http", "Website (HTTP/HTTPS)"], ["keyword", "Website with a word on the page"], ["json", "Website answer (JSON field)"], ["tcp", "Port (is a service listening)"],
  ["ping", "Ping a host"], ["dns", "DNS name"], ["cert", "Certificate expiry"], ["push", "Heartbeat (a script reports in)"]
] as const;
const METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"];

export const BLANK_MONITOR = {
  kind: "http", name: "", group: "", description: "", target: "", port: "", keyword: "", invert: false, jsonPath: "", expect: "200-299", method: "GET", body: "", headers: "", authUser: "", authPass: "",
  maxRedirects: 5, upsideDown: false, dnsType: "A", dnsServer: "", intervalSeconds: 60, retryIntervalSeconds: 20, timeoutSeconds: 10, retries: 1, insecureTls: false, certWarnDays: 14
};
export type MonitorFormValues = typeof BLANK_MONITOR;

export const formFrom = (c: MonitorConfigInfo): MonitorFormValues => ({ ...BLANK_MONITOR, ...c, port: c.port ? String(c.port) : "", authPass: "" } as MonitorFormValues);

/** Add or change a monitor. Every field here is saved as typed; the server checks it again. */
export function MonitorForm({ id, start, groups, pushBase, onClose, onSaved }: {
  id?: string; start: MonitorFormValues; groups: string[]; pushBase: string; hasPass?: boolean; onClose: () => void; onSaved: (text: string) => void;
}) {
  const [f, setF] = useState<MonitorFormValues>(start);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState("");
  const set = <K extends keyof MonitorFormValues>(k: K, v: MonitorFormValues[K]) => setF(x => ({ ...x, [k]: v }));
  const web = f.kind === "http" || f.kind === "keyword" || f.kind === "json";
  const body = () => ({ ...f, port: f.port === "" ? 0 : Number(f.port), id });
  const test = async () => {
    setBusy("test"); setMsg(null);
    try { const r = await api.post<{ up: boolean; message: string; ms: number | null }>("/api/monitors/test", body()); setMsg({ ok: r.up, text: `${r.up ? "Works" : "Fails"}: ${r.message}${r.ms !== null ? ` (${r.ms} ms)` : ""}` }); }
    catch (e) { setMsg({ ok: false, text: e instanceof Error ? e.message : "Could not test" }); }
    setBusy("");
  };
  const save = async () => {
    setBusy("save"); setMsg(null);
    try { if (id) await api.put(`/api/monitors/${id}`, body()); else await api.post("/api/monitors", body()); onSaved(id ? "Saved." : "Monitor added. It is checked right away."); }
    catch (e) { setMsg({ ok: false, text: e instanceof Error ? e.message : "Could not save" }); setBusy(""); }
  };
  const pushUrl = f.kind === "push" && id && start.kind === "push" ? `${pushBase}/api/push/${start.target}?status=up&msg=OK` : "";

  return (
    <Modal title={id ? "Edit monitor" : "Add a monitor"} eyebrow="Monitoring" onClose={onClose} wide>
      <div className="form">
        <div className="row2">
          <Field label="What to check"><select value={f.kind} onChange={e => set("kind", e.target.value)}>{KINDS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></Field>
          <Field label="Name"><input value={f.name} maxLength={60} placeholder="Shown on the dashboard" onChange={e => set("name", e.target.value)} /></Field>
        </div>
        <div className="row2">
          <Field label="Group (optional)" hint="Monitors with the same group are shown together, for example Arrs or Plex servers."><input list="monitor-groups" value={f.group} maxLength={40} placeholder="Pick one or type a new name" onChange={e => set("group", e.target.value)} /></Field>
          <Field label="Description (optional)" hint="A short note shown under the name."><input value={f.description} maxLength={200} onChange={e => set("description", e.target.value)} /></Field>
          <datalist id="monitor-groups">{groups.map(g => <option key={g} value={g} />)}</datalist>
        </div>

        {web && <Field label="Address" hint="The full address, for example https://nas.example.com or http://192.168.1.10:8989."><input value={f.target} placeholder="https://" onChange={e => set("target", e.target.value)} /></Field>}
        {(f.kind === "tcp" || f.kind === "cert") && (
          <div className="row2">
            <Field label="Host" hint="A host name or IP address."><input value={f.target} onChange={e => set("target", e.target.value)} /></Field>
            <Field label="Port" hint={f.kind === "cert" ? "443 if left empty." : undefined}><input inputMode="numeric" value={f.port} onChange={e => set("port", e.target.value.replace(/\D/g, "").slice(0, 5))} /></Field>
          </div>
        )}
        {f.kind === "ping" && <Field label="Host" hint="A host name or IP address. The ping is sent from this machine."><input value={f.target} onChange={e => set("target", e.target.value)} /></Field>}
        {f.kind === "dns" && (
          <>
            <div className="row2">
              <Field label="Name to look up" hint="For example example.com"><input value={f.target} onChange={e => set("target", e.target.value)} /></Field>
              <Field label="Record type"><select value={f.dnsType} onChange={e => set("dnsType", e.target.value)}>{["A", "AAAA", "CNAME", "MX", "TXT", "NS"].map(t => <option key={t}>{t}</option>)}</select></Field>
            </div>
            <div className="row2">
              <Field label="Answer must contain (optional)"><input value={f.keyword} maxLength={200} onChange={e => set("keyword", e.target.value)} /></Field>
              <Field label="Ask this DNS server (optional)" hint="An IP address such as 192.168.1.1. Empty uses this machine's own."><input value={f.dnsServer} onChange={e => set("dnsServer", e.target.value)} /></Field>
            </div>
          </>
        )}
        {f.kind === "push" && (
          <p className="sub">{id && pushUrl
            ? <>Have your script open this address at least as often as the check interval below. Add <code>status=down</code> to report a failure and <code>ping=123</code> for a response time in ms: <code className="brk">{pushUrl}</code></>
            : "After saving, Homebase shows the address your script should call. The monitor goes down when no call arrives within the check interval."}</p>
        )}

        {f.kind === "keyword" && (
          <div className="row2">
            <Field label="Word or phrase on the page" hint="Not case sensitive."><input value={f.keyword} maxLength={200} onChange={e => set("keyword", e.target.value)} /></Field>
            <Field label="Counts as up when"><select value={f.invert ? "absent" : "present"} onChange={e => set("invert", e.target.value === "absent")}><option value="present">The word is on the page</option><option value="absent">The word is NOT on the page</option></select></Field>
          </div>
        )}
        {f.kind === "json" && (
          <div className="row2">
            <Field label="Field to read" hint="For example status or data.items[0].state."><input value={f.jsonPath} maxLength={200} onChange={e => set("jsonPath", e.target.value)} /></Field>
            <Field label="Must equal (optional)" hint="Empty only checks that the field exists."><input value={f.keyword} maxLength={200} onChange={e => set("keyword", e.target.value)} /></Field>
          </div>
        )}
        {web && (
          <>
            <div className="row2">
              <Field label="Status codes that count as up" hint="For example 200-299 or 200,301,404."><input value={f.expect} onChange={e => set("expect", e.target.value)} /></Field>
              <Field label="Request type"><select value={f.method} onChange={e => set("method", e.target.value)}>{METHODS.filter(m => f.kind === "http" || m !== "HEAD").map(m => <option key={m} value={m}>{m}</option>)}</select></Field>
            </div>
            <div className="row2">
              <Field label="Follow up to (redirects)" hint="0 does not follow redirects."><input type="number" min={0} max={10} value={f.maxRedirects} onChange={e => set("maxRedirects", Number(e.target.value))} /></Field>
              <label className="chk fcheck"><input type="checkbox" checked={f.insecureTls} onChange={e => set("insecureTls", e.target.checked)} /> Allow a self-signed or expired certificate</label>
            </div>
            <div className="row2">
              <Field label="Basic auth user (optional)"><input value={f.authUser} maxLength={100} autoComplete="off" onChange={e => set("authUser", e.target.value)} /></Field>
              <Field label="Basic auth password" hint={id && f.authUser ? "Leave empty to keep the saved password." : undefined}><input type="password" value={f.authPass} maxLength={200} autoComplete="new-password" onChange={e => set("authPass", e.target.value)} /></Field>
            </div>
            <Field label="Request headers (optional)" hint="One per line, like X-Api-Key: abc123. Stored encrypted."><textarea rows={3} value={f.headers} maxLength={2000} spellCheck={false} onChange={e => set("headers", e.target.value)} /></Field>
            {f.method !== "GET" && f.method !== "HEAD" && <Field label="Request body (optional)"><textarea rows={3} value={f.body} maxLength={4000} spellCheck={false} onChange={e => set("body", e.target.value)} /></Field>}
          </>
        )}

        <div className="row2">
          <Field label="Check every (seconds)" hint="At least 20."><input type="number" min={20} max={86400} value={f.intervalSeconds} onChange={e => set("intervalSeconds", Number(e.target.value))} /></Field>
          <Field label="Give up after (seconds)" hint="Up to 60."><input type="number" min={1} max={60} value={f.timeoutSeconds} onChange={e => set("timeoutSeconds", Number(e.target.value))} /></Field>
        </div>
        <div className="row2">
          <Field label="Retries before it counts as down" hint="0 to 10."><input type="number" min={0} max={10} value={f.retries} onChange={e => set("retries", Number(e.target.value))} /></Field>
          <Field label="Retry every (seconds)" hint="How soon a failed check is repeated."><input type="number" min={20} max={86400} value={f.retryIntervalSeconds} onChange={e => set("retryIntervalSeconds", Number(e.target.value))} /></Field>
        </div>
        <div className="row2">
          {(web || f.kind === "cert") ? <Field label="Warn when the certificate ends within (days)" hint="0 turns the warning off."><input type="number" min={0} max={365} value={f.certWarnDays} onChange={e => set("certWarnDays", Number(e.target.value))} /></Field> : <span />}
          <label className="chk fcheck"><input type="checkbox" checked={f.upsideDown} onChange={e => set("upsideDown", e.target.checked)} /> Upside-down mode: down when it is reachable, up when it is not</label>
        </div>
        {msg && <p className={msg.ok ? "ok-note" : "error"} role={msg.ok ? "status" : "alert"}>{msg.text}</p>}
        <div className="acts">
          {f.kind !== "push" ? <button className="btn" disabled={busy !== ""} onClick={() => void test()}>{busy === "test" ? "Testing…" : "Test"}</button> : <span />}
          <span className="acts-right"><button className="btn" onClick={onClose}>Cancel</button><button className="btn pri" disabled={busy !== ""} onClick={() => void save()}>{busy === "save" ? "Saving…" : "Save"}</button></span>
        </div>
      </div>
    </Modal>
  );
}
