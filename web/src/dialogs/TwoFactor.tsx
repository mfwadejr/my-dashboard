import { useEffect, useState } from "react";
import { api } from "../api";
import type { AuthUser } from "../types";

interface Setup { secret: string; otpauthUrl: string; qrSvg: string }

/** Turn two-factor sign-in on or off for your own account, and keep its recovery codes. */
export function TwoFactorPanel({ me, onChanged }: { me: AuthUser; onChanged: () => void }) {
  const [state, setState] = useState<{ enabled: boolean; recoveryLeft: number } | null>(null);
  const [step, setStep] = useState<"idle" | "password" | "scan" | "codes" | "off" | "newcodes">("idle");
  const [pw, setPw] = useState(""), [code, setCode] = useState("");
  const [setup, setSetup] = useState<Setup | null>(null);
  const [codes, setCodes] = useState<string[]>([]);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = () => api.get<{ enabled: boolean; recoveryLeft: number }>("/api/auth/2fa").then(setState).catch(() => {});
  useEffect(() => { void load(); }, []);
  const run = async (f: () => Promise<void>) => { setBusy(true); setMsg(null); try { await f(); } catch (e) { setMsg({ ok: false, text: e instanceof Error ? e.message : "That did not work" }); } setBusy(false); };
  const reset = () => { setStep("idle"); setPw(""); setCode(""); setSetup(null); };

  const begin = () => run(async () => { setSetup(await api.post<Setup>("/api/auth/2fa/setup", { password: pw })); setPw(""); setStep("scan"); });
  const enable = () => run(async () => { const r = await api.post<{ recoveryCodes: string[] }>("/api/auth/2fa/enable", { code }); setCodes(r.recoveryCodes); setStep("codes"); setCode(""); setSetup(null); void load(); onChanged(); });
  const disable = () => run(async () => { await api.post("/api/auth/2fa/disable", { password: pw, code }); reset(); setMsg({ ok: true, text: "Two-factor sign-in is off." }); void load(); onChanged(); });
  const newCodes = () => run(async () => { const r = await api.post<{ recoveryCodes: string[] }>("/api/auth/2fa/recovery", { password: pw, code }); setCodes(r.recoveryCodes); setStep("codes"); setPw(""); setCode(""); void load(); });
  const copy = () => { void navigator.clipboard?.writeText(codes.join("\n")).then(() => setMsg({ ok: true, text: "Copied." }), () => {}); };

  return (
    <div className="twofa">
      {state?.enabled && step === "idle" && (
        <>
          <p><b>Two-factor sign-in is on.</b> After your password you also enter a code from your authenticator app. {state.recoveryLeft} recovery code(s) left.</p>
          {state.recoveryLeft <= 3 && <p className="error">You are running low on recovery codes. Make new ones.</p>}
          <div className="acts"><button className="btn" onClick={() => setStep("newcodes")}>New recovery codes…</button><button className="btn" onClick={() => setStep("off")}>Turn off…</button></div>
        </>
      )}
      {state && !state.enabled && step === "idle" && (
        <>
          <p className="sub">Adds a second step to signing in: a six-digit code from an app such as Google Authenticator, Microsoft Authenticator, 1Password or Aegis. Worth having if Homebase is ever reachable from outside your home.</p>
          <div className="acts"><button className="btn pri" onClick={() => setStep("password")}>Set up two-factor sign-in…</button></div>
        </>
      )}
      {step === "password" && (
        <form className="form" onSubmit={e => { e.preventDefault(); void begin(); }}>
          <label className="field"><span>Your password</span><input type="password" autoFocus autoComplete="current-password" value={pw} onChange={e => setPw(e.target.value)} /></label>
          <div className="acts"><button type="button" className="btn" onClick={reset}>Cancel</button><button className="btn pri" disabled={busy || !pw}>Continue</button></div>
        </form>
      )}
      {step === "scan" && setup && (
        <form className="form" onSubmit={e => { e.preventDefault(); void enable(); }}>
          <p>1. Scan this with your authenticator app (or type the key in by hand).</p>
          <div className="qr" dangerouslySetInnerHTML={{ __html: setup.qrSvg }} aria-label="QR code" />
          <p className="sub">Key: <code>{setup.secret}</code></p>
          <label className="field"><span>2. Enter the six-digit code it shows</span><input inputMode="numeric" autoComplete="one-time-code" maxLength={7} value={code} onChange={e => setCode(e.target.value)} /></label>
          <div className="acts"><button type="button" className="btn" onClick={reset}>Cancel</button><button className="btn pri" disabled={busy || code.replace(/\s/g, "").length !== 6}>Turn on</button></div>
        </form>
      )}
      {step === "codes" && (
        <div className="preview warnbox">
          <b>Save these recovery codes now.</b>
          <p className="sub">Each one works once if you lose your phone. They are shown only this time. Store them somewhere safe, apart from this device (a password manager is ideal).</p>
          <pre className="codes">{codes.join("\n")}</pre>
          <div className="acts"><button className="btn" onClick={copy}>Copy</button><button className="btn pri" onClick={reset}>I have saved them</button></div>
        </div>
      )}
      {(step === "off" || step === "newcodes") && (
        <form className="form" onSubmit={e => { e.preventDefault(); void (step === "off" ? disable() : newCodes()); }}>
          <p className="sub">{step === "off" ? "Enter your password and a current code (or a recovery code) to turn it off." : "Making new codes replaces the old ones. Enter your password and a current code."}</p>
          <label className="field"><span>Your password</span><input type="password" autoComplete="current-password" value={pw} onChange={e => setPw(e.target.value)} /></label>
          <label className="field"><span>Code or recovery code</span><input autoComplete="one-time-code" value={code} onChange={e => setCode(e.target.value)} /></label>
          <div className="acts"><button type="button" className="btn" onClick={reset}>Cancel</button><button className="btn pri" disabled={busy || !pw || !code}>{step === "off" ? "Turn off" : "Make new codes"}</button></div>
        </form>
      )}
      {msg && <p className={msg.ok ? "ok-note" : "error"} role="status">{msg.text}</p>}
      <span hidden>{me.id}</span>
    </div>
  );
}
