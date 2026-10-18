import { useState } from "react";
import { api } from "../api";
import type { AuthUser } from "../types";
import { Field, Modal } from "./Modal";
import { TwoFactorPanel } from "./TwoFactor";

/** For every signed-in person: change your own password or sign out of all devices. */
export function AccountDialog({ me, onSignedOut, onClose }: { me: AuthUser; onSignedOut: () => void; onClose: () => void }) {
  const [cur, setCur] = useState(""); const [next, setNext] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const change = async () => {
    setBusy(true); setMsg(null);
    try { await api.post("/api/auth/password", { current: cur, next }); setMsg({ ok: true, text: "Password changed. Your other devices were signed out." }); setCur(""); setNext(""); }
    catch (e) { setMsg({ ok: false, text: e instanceof Error ? e.message : "Could not change it" }); }
    setBusy(false);
  };
  return (
    <Modal title={me.username} eyebrow={me.role === "admin" ? "Admin account" : "Viewer account"} onClose={onClose}>
      <form className="form" onSubmit={e => { e.preventDefault(); void change(); }}>
        <Field label="Current password"><input type="password" autoComplete="current-password" value={cur} onChange={e => setCur(e.target.value)} /></Field>
        <Field label="New password" hint="At least 8 characters."><input type="password" autoComplete="new-password" value={next} onChange={e => setNext(e.target.value)} /></Field>
        {msg && <p className={msg.ok ? "ok-note" : "error"} role="status">{msg.text}</p>}
        <div className="acts"><button type="button" className="btn" onClick={async () => { await api.post("/api/auth/logout-all"); onSignedOut(); }}>Sign out everywhere</button><button className="btn pri" disabled={busy || !cur || next.length < 8}>Change password</button></div>
      </form>
      <h3 className="subhead">Two-factor sign-in</h3>
      <TwoFactorPanel me={me} onChanged={() => undefined} />
    </Modal>
  );
}
