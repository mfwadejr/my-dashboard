import { useEffect, useState } from "react";
import { api, assignIcon } from "../api";
import { IconButton } from "../components/IconButton";
import { Confirm, Pill } from "../widgets/common";
import { fmtDateTime, useSettings } from "../settings";
import type { AuthUser } from "../types";
import { TwoFactorPanel } from "../dialogs/TwoFactor";
import { Row, Section, deviceName, useNotice, useSaveSettings } from "./ui";

interface UserRow { id: string; username: string; role: "admin" | "viewer"; disabled: boolean; createdAt: number; totpEnabled?: boolean; icon?: string; iconRef?: string }
interface SessionRow { id: string; username: string; createdAt: number; lastSeen: number; ip: string; ua: string; current: boolean }

export function Access({ me, onSignedOut }: { me: AuthUser; onSignedOut: () => void }) {
  const { settings } = useSettings();
  const [users, setUsers] = useState<UserRow[]>([]);
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [nu, setNu] = useState({ username: "", password: "", role: "viewer" });
  const [cur, setCur] = useState(""); const [next, setNext] = useState("");
  const [reset, setReset] = useState<{ id: string; pw: string } | null>(null);
  const a = useNotice(), p = useNotice(), s = useNotice();
  const idle = useSaveSettings();

  const load = () => { void api.get<UserRow[]>("/api/users").then(setUsers).catch(() => {}); void api.get<SessionRow[]>("/api/sessions").then(setSessions).catch(() => {}); };
  useEffect(load, []);

  const create = async () => {
    a.clear();
    try { await api.post("/api/users", nu); a.ok(`Created "${nu.username}".`); setNu({ username: "", password: "", role: "viewer" }); load(); } catch (e) { a.bad(e); }
  };
  const patch = async (id: string, body: object, okText: string) => { a.clear(); try { await api.put(`/api/users/${id}`, body); a.ok(okText); setReset(null); load(); } catch (e) { a.bad(e); } };
  const changePw = async () => {
    p.clear();
    try { await api.post("/api/auth/password", { current: cur, next }); p.ok("Password changed. Your other devices were signed out."); setCur(""); setNext(""); load(); } catch (e) { p.bad(e); }
  };

  return (
    <>
      <Section title="People" hint={<>Admins can change everything. Viewers can look at the dashboard and cameras but can't change anything. To share just some cameras with someone, use a link under <b>Sharing</b> instead of an account.</>}>
        <div className="rows">
          {users.map(u => (
            <div key={u.id} className="srow">
              <div className="who"><IconButton icon={u.icon} iconRef={u.iconRef} name={u.username} size={22} onChange={async v => { await assignIcon("account", u.id, v); load(); }} /><b>{u.username}</b> {u.id === me.id && <Pill tone="mute">you</Pill>} <Pill tone={u.role === "admin" ? "warn" : "mute"}>{u.role}</Pill> {u.disabled && <Pill tone="bad">switched off</Pill>} {u.totpEnabled && <Pill tone="ok">2-step</Pill>}
                <div className="sub">Added {new Date(u.createdAt).toLocaleDateString([], { timeZone: settings.timezone })}</div>
                {reset?.id === u.id && <div className="row wrapme mt6"><input type="password" autoComplete="new-password" placeholder="New password" value={reset.pw} onChange={e => setReset({ id: u.id, pw: e.target.value })} /><button className="btn sm pri" disabled={reset.pw.length < 8} onClick={() => void patch(u.id, { password: reset.pw }, `Password reset for "${u.username}".`)}>Set</button><button className="btn sm" onClick={() => setReset(null)}>Cancel</button></div>}
              </div>
              <span className="row wrapme">
                <select value={u.role} aria-label={`Role of ${u.username}`} onChange={e => void patch(u.id, { role: e.target.value }, `"${u.username}" is now ${e.target.value === "admin" ? "an admin" : "a viewer"}.`)}><option value="viewer">Viewer</option><option value="admin">Admin</option></select>
                <button className="btn sm" onClick={() => setReset({ id: u.id, pw: "" })}>Reset password</button>
                {u.id !== me.id && u.totpEnabled && <Confirm label="Reset 2-step" name={`Reset two-factor for ${u.username}`} sure="Sure?" onGo={() => patch(u.id, { resetTwoFactor: true }, `Two-factor sign-in was turned off for "${u.username}". They can set it up again.`)} />}
                {u.id !== me.id && <button className="btn sm" onClick={() => void patch(u.id, { disabled: !u.disabled }, u.disabled ? "Switched on." : "Switched off and signed out.")}>{u.disabled ? "Switch on" : "Switch off"}</button>}
                {u.id !== me.id && <Confirm label="Delete" name={`Delete ${u.username}`} sure="Sure?" onGo={async () => { a.clear(); try { await api.del(`/api/users/${u.id}`); a.ok("Deleted."); load(); } catch (e) { a.bad(e); } }} />}
              </span>
            </div>
          ))}
        </div>
        <form className="addrow" onSubmit={e => { e.preventDefault(); void create(); }}>
          <input placeholder="Username" autoComplete="off" value={nu.username} maxLength={32} onChange={e => setNu({ ...nu, username: e.target.value })} />
          <input type="password" placeholder="Password (8+ characters)" autoComplete="new-password" value={nu.password} onChange={e => setNu({ ...nu, password: e.target.value })} />
          <select value={nu.role} onChange={e => setNu({ ...nu, role: e.target.value })}><option value="viewer">Viewer</option><option value="admin">Admin</option></select>
          <button className="btn pri" disabled={!nu.username || nu.password.length < 8}>Add person</button>
        </form>
        {a.el}
      </Section>

      <Section title="Your password" hint={`Signed in as ${me.username}. Changing it signs out your other devices.`}>
        <Row label="Current password"><input type="password" autoComplete="current-password" value={cur} onChange={e => setCur(e.target.value)} /></Row>
        <Row label="New password"><input type="password" autoComplete="new-password" value={next} onChange={e => setNext(e.target.value)} /></Row>
        <Row label=""><button className="btn pri" disabled={!cur || next.length < 8} onClick={() => void changePw()}>Change password</button></Row>
        {p.el}
      </Section>

      <Section title="Two-factor sign-in" hint="Your own account. Each person turns this on for themselves; an admin can switch it off for someone who lost their phone and codes.">
        <TwoFactorPanel me={me} onChanged={load} />
      </Section>

      <Section title="Idle sign-out" hint="Signs admins out after a quiet spell, so a forgotten browser tab cannot change things. Wall displays (kiosk mode) and viewers are not affected.">
        <Row label="Sign admins out after"><select value={settings.idleMinutes} onChange={e => void idle.save({ idleMinutes: Number(e.target.value) })}>{[[0, "Never"], [15, "15 minutes"], [30, "30 minutes"], [60, "1 hour"], [240, "4 hours"], [720, "12 hours"]].map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></Row>
        {idle.el}
      </Section>

      <Section title="Signed-in devices" hint="Every browser that is signed in right now. End any you don't recognise.">
        <div className="rows">{sessions.map(x => (
          <div key={x.id} className="srow"><div><b>{x.username}</b> {x.current && <Pill tone="ok">this device</Pill>}<div className="sub">{deviceName(x.ua)} · {x.ip || "unknown address"} · last active {fmtDateTime(x.lastSeen, settings)}</div></div>
            {!x.current && <Confirm label="End" name="End session" sure="Sure?" onGo={async () => { try { await api.del(`/api/sessions/${x.id}`); load(); } catch (e) { s.bad(e); } }} />}</div>
        ))}</div>
        <Row label="" hint="Signs this account out everywhere, including here."><Confirm label="Sign me out everywhere" name="Sign out everywhere" sure="Click again to sign out" onGo={async () => { await api.post("/api/auth/logout-all"); onSignedOut(); }} /></Row>
        {s.el}
      </Section>
    </>
  );
}
