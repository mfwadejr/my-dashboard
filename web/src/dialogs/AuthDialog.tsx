import { useState } from "react";
import { api } from "../api";
import { Field, Modal } from "./Modal";

export function AuthDialog({ setup, onDone, onClose }: { setup: boolean; onDone: () => void; onClose: () => void }) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setError("");
    if (setup && password.length < 8) return setError("Use at least 8 characters.");
    if (setup && password !== confirm) return setError("The two passwords do not match.");
    setBusy(true);
    try { await api.post(setup ? "/api/auth/setup" : "/api/auth/login", { password }); onDone(); }
    catch (e) { setError(e instanceof Error ? e.message : "Could not sign in"); }
    setBusy(false);
  };
  return (
    <Modal title={setup ? "Create your admin password" : "Sign in to edit"} eyebrow={setup ? "First-time setup" : "Admin"} onClose={onClose}>
      {setup && <p className="sub">Anyone on your network can view this dashboard. This password is only needed to change it. Choose one you don't use elsewhere.</p>}
      <form onSubmit={e => { e.preventDefault(); void submit(); }} className="form">
        <Field label="Password"><input type="password" autoFocus autoComplete={setup ? "new-password" : "current-password"} value={password} onChange={e => setPassword(e.target.value)} /></Field>
        {setup && <Field label="Confirm password"><input type="password" autoComplete="new-password" value={confirm} onChange={e => setConfirm(e.target.value)} /></Field>}
        {error && <p className="error" role="alert">{error}</p>}
        <div className="acts"><span /><button className="btn pri" disabled={busy || !password}>{setup ? "Create password" : "Sign in"}</button></div>
      </form>
    </Modal>
  );
}
