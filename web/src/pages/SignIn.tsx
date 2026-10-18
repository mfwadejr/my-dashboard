import { useState } from "react";
import { api } from "../api";

/** Nothing is shown to anyone who has not signed in. The very first visit creates the admin account. */
export function SignIn({ setup, onDone }: { setup: boolean; onDone: () => void }) {
  const [username, setUsername] = useState(setup ? "admin" : "");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setError("");
    if (setup && password.length < 8) return setError("Use at least 8 characters.");
    if (setup && password !== confirm) return setError("The two passwords do not match.");
    setBusy(true);
    try { await api.post(setup ? "/api/auth/setup" : "/api/auth/login", { username: username.trim(), password }); onDone(); }
    catch (e) { setError(e instanceof Error ? e.message : "Could not sign in"); }
    setBusy(false);
  };
  return (
    <div className="signin">
      <form className="signin-card form" onSubmit={e => { e.preventDefault(); void submit(); }}>
        <div className="logo big"><i />Homebase</div>
        <h1>{setup ? "Welcome. Create the admin account" : "Sign in"}</h1>
        {setup && <p className="sub">This account manages everything: connections, cameras, other people's access and backups. Choose a password you don't use anywhere else. You can add read-only viewer accounts later.</p>}
        <label className="field"><span>Username</span><input autoFocus={!setup || true} autoComplete="username" value={username} onChange={e => setUsername(e.target.value)} maxLength={32} /></label>
        <label className="field"><span>Password</span><input type="password" autoComplete={setup ? "new-password" : "current-password"} value={password} onChange={e => setPassword(e.target.value)} /></label>
        {setup && <label className="field"><span>Confirm password</span><input type="password" autoComplete="new-password" value={confirm} onChange={e => setConfirm(e.target.value)} /></label>}
        {error && <p className="error" role="alert">{error}</p>}
        <button className="btn pri" disabled={busy || !username || !password}>{setup ? "Create account" : "Sign in"}</button>
      </form>
    </div>
  );
}
