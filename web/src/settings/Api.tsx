import { useEffect, useState } from "react";
import { api, assignIcon } from "../api";
import { IconButton } from "../components/IconButton";
import { Confirm, Pill } from "../widgets/common";
import { fmtDateTime, useSettings } from "../settings";
import { Row, Section, ago, useNotice } from "./ui";

interface Token { id: string; name: string; prefix: string; scope: "read" | "write"; createdAt: number; createdBy: string; lastUsed: number | null; lastIp: string; uses: number; revoked: boolean; icon?: string; iconRef?: string }

/** Keys other tools use to read (or change) the dashboard without a login. */
export function ApiAccess() {
  const { settings } = useSettings();
  const [items, setItems] = useState<Token[]>([]);
  const [name, setName] = useState(""), [scope, setScope] = useState<"read" | "write">("read");
  const [fresh, setFresh] = useState<{ name: string; token: string } | null>(null);
  const n = useNotice();
  const load = () => { void api.get<Token[]>("/api/tokens").then(setItems).catch(() => {}); };
  useEffect(load, []);

  const make = async () => {
    n.clear();
    try { const r = await api.post<Token & { token: string }>("/api/tokens", { name: name.trim(), scope }); setFresh({ name: r.name, token: r.token }); setName(""); load(); }
    catch (e) { n.bad(e); }
  };
  const copy = (t: string) => { void navigator.clipboard?.writeText(t).then(() => n.ok("Copied."), () => {}); };
  const origin = window.location.origin;

  return (
    <>
      <Section title="API access" hint={<>A token lets another tool, such as Home Assistant, a script or a status board, read this dashboard without signing in. Tokens can never manage people, backups, sharing or other tokens, even a read-write one.</>}>
        <div className="rows">
          {items.length === 0 && <p className="sub">No tokens yet.</p>}
          {items.map(t => (
            <div key={t.id} className="srow">
              <div className="who"><IconButton icon={t.icon} iconRef={t.iconRef} name={t.name} size={22} onChange={async v => { await assignIcon("token", t.id, v); load(); }} /><b>{t.name}</b> <Pill tone={t.scope === "write" ? "warn" : "mute"}>{t.scope === "write" ? "read-write" : "read-only"}</Pill> {t.revoked && <Pill tone="bad">revoked</Pill>} <code>{t.prefix}…</code>
                <div className="sub">Made {fmtDateTime(t.createdAt, settings)} by {t.createdBy} · {t.lastUsed ? `last used ${ago(t.lastUsed)}${t.lastIp ? ` from ${t.lastIp}` : ""} · ${t.uses.toLocaleString()} use(s)` : "never used"}</div></div>
              <span className="row wrapme">
                {!t.revoked && <Confirm label="Revoke" name={`Revoke ${t.name}`} sure="Stops working now. Sure?" onGo={async () => { try { await api.post(`/api/tokens/${t.id}/revoke`); load(); } catch (e) { n.bad(e); } }} />}
                <Confirm label="Delete" name={`Delete ${t.name}`} sure="Sure?" onGo={async () => { try { await api.del(`/api/tokens/${t.id}`); load(); } catch (e) { n.bad(e); } }} />
              </span>
            </div>
          ))}
        </div>
        <form className="addrow" onSubmit={e => { e.preventDefault(); void make(); }}>
          <input placeholder="What will use it? e.g. Home Assistant" maxLength={40} value={name} onChange={e => setName(e.target.value)} aria-label="Token name" />
          <select value={scope} onChange={e => setScope(e.target.value as "read" | "write")} aria-label="Access"><option value="read">Read-only</option><option value="write">Read-write</option></select>
          <button className="btn pri" disabled={!name.trim()}>Make token</button>
        </form>
        {fresh && (
          <div className="preview warnbox">
            <b>Copy the token for "{fresh.name}" now.</b>
            <p className="sub">It is shown only this once. Homebase keeps just a fingerprint, so a lost token cannot be recovered, only replaced.</p>
            <pre className="codes">{fresh.token}</pre>
            <div className="acts"><button className="btn" onClick={() => copy(fresh.token)}>Copy</button><button className="btn pri" onClick={() => setFresh(null)}>I have saved it</button></div>
          </div>
        )}
        {n.el}
      </Section>

      <Section title="Using a token" hint="Send it as a Bearer header. Tokens work on the normal address; there is no separate port.">
        <Row label="Quick check" hint="A flat summary of every connection's state, made for other tools."><pre className="codes">{`curl -H "Authorization: Bearer hb_…" ${origin}/api/summary`}</pre></Row>
        <Row label="Limits" hint="Each token is limited to 600 requests a minute. Every use is counted above and written to the log under the area “api” (repeat calls inside a minute are grouped; set the log detail to Detailed to list each one)."><span className="sub">Read-only tokens can read what a viewer can see (but not camera video). Read-write tokens can also change the layout, connections and cameras, but never people, backups, sharing or tokens.</span></Row>
      </Section>
    </>
  );
}
