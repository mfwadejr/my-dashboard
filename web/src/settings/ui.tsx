import { useState, type ReactNode } from "react";
import { api } from "../api";
import { useSettings } from "../settings";
import type { SettingsDoc } from "../types";

export function Section({ title, hint, children, danger }: { title: string; hint?: ReactNode; children: ReactNode; danger?: boolean }) {
  return (
    <section className={`setsec${danger ? " danger" : ""}`}>
      <h3>{title}</h3>
      {hint && <p className="sub">{hint}</p>}
      <div className="setbody">{children}</div>
    </section>
  );
}

export function Row({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="setrow">
      <div className="setlabel"><span>{label}</span>{hint && <small>{hint}</small>}</div>
      <div className="setctl">{children}</div>
    </div>
  );
}

export function useNotice() {
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const el = note ? <p className={note.ok ? "ok-note" : "error"} role={note.ok ? "status" : "alert"}>{note.text}</p> : null;
  return { note, setNote, el, ok: (text: string) => setNote({ ok: true, text }), bad: (e: unknown) => setNote({ ok: false, text: e instanceof Error ? e.message : "That did not work" }), clear: () => setNote(null) };
}

/** Saves one or more settings and refreshes everyone's copy. */
export function useSaveSettings() {
  const { reload } = useSettings();
  const n = useNotice();
  const save = async (patch: Partial<SettingsDoc>) => {
    try { await api.put("/api/settings", patch); await reload(); n.ok("Saved"); window.setTimeout(n.clear, 1800); }
    catch (e) { n.bad(e); }
  };
  return { save, ...n };
}

export const bytes = (n: number) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1e3))} KB`);

export function ago(ms: number | null | undefined): string {
  if (!ms) return "never";
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}

export function download(filename: string, text: string, type = "application/json") {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/** A short description of a browser from its user-agent text. */
export function deviceName(ua: string): string {
  const os = /iPhone|iPad/.test(ua) ? "iPhone/iPad" : /Android/.test(ua) ? "Android" : /Mac OS/.test(ua) ? "Mac" : /Windows/.test(ua) ? "Windows" : /Linux/.test(ua) ? "Linux" : "";
  const br = /Edg\//.test(ua) ? "Edge" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "";
  return [br, os].filter(Boolean).join(" on ") || "Unknown device";
}

/** Copies text. The clipboard API only exists on https or localhost, and Homebase is often opened over plain http on a home network, so fall back to the older method. Returns whether it worked. */
export async function copyText(text: string): Promise<boolean> {
  try { if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(text); return true; } } catch { /* try the fallback */ }
  const ta = document.createElement("textarea");
  ta.value = text; ta.setAttribute("readonly", ""); ta.style.cssText = "position:fixed;top:0;left:0;opacity:0;";
  const keep = document.activeElement as HTMLElement | null;
  document.body.appendChild(ta); ta.select(); ta.setSelectionRange(0, text.length);
  let ok = false;
  try { ok = document.execCommand("copy"); } catch { ok = false; }
  ta.remove(); keep?.focus?.();
  return ok;
}
