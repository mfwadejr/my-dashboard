import { useEffect, useState } from "react";
import { api } from "../api";
import type { IntegrationInfo, IntegrationType } from "../types";
import { Field, Modal } from "./Modal";

interface Form { id?: string; type: string; name: string; url: string; apiKey: string; intervalSeconds: number; insecureTls: boolean }

export function IntegrationsDialog({ integrations, onChanged, onClose }: { integrations: IntegrationInfo[]; onChanged: () => void; onClose: () => void }) {
  const [types, setTypes] = useState<IntegrationType[]>([]);
  const [form, setForm] = useState<Form | null>(null);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  useEffect(() => { void api.get<IntegrationType[]>("/api/integration-types").then(setTypes); }, []);

  const type = types.find(t => t.id === form?.type);
  const set = (patch: Partial<Form>) => { setForm(f => (f ? { ...f, ...patch } : f)); setResult(null); };
  const add = (t: IntegrationType) => { setForm({ type: t.id, name: t.name, url: "", apiKey: "", intervalSeconds: 15, insecureTls: false }); setResult(null); setConfirmDelete(false); };
  const edit = (i: IntegrationInfo) => { setForm({ id: i.id, type: i.type, name: i.name, url: i.url ?? "", apiKey: "", intervalSeconds: i.intervalSeconds ?? 15, insecureTls: Boolean(i.insecureTls) }); setResult(null); setConfirmDelete(false); };

  const test = async () => {
    if (!form) return;
    setBusy(true); setResult(null);
    try { setResult(await api.post("/api/integrations/test", { id: form.id, type: form.type, url: form.url, apiKey: form.apiKey, insecureTls: form.insecureTls })); }
    catch (e) { setResult({ ok: false, message: e instanceof Error ? e.message : "Test failed" }); }
    setBusy(false);
  };
  const save = async () => {
    if (!form) return;
    setBusy(true);
    try {
      if (form.id) await api.put(`/api/integrations/${form.id}`, form); else await api.post("/api/integrations", form);
      onChanged(); setForm(null);
    } catch (e) { setResult({ ok: false, message: e instanceof Error ? e.message : "Could not save" }); }
    setBusy(false);
  };
  const remove = async () => {
    if (!form?.id) return;
    if (!confirmDelete) { setConfirmDelete(true); return; }
    setBusy(true);
    try { await api.del(`/api/integrations/${form.id}`); onChanged(); setForm(null); } catch (e) { setResult({ ok: false, message: e instanceof Error ? e.message : "Could not remove" }); }
    setBusy(false);
  };

  return (
    <Modal title="Connections" eyebrow="Settings" onClose={onClose} wide>
      {!form ? (
        <>
          <p className="sub">Connect the apps you want to show on tiles. Keys are stored encrypted on the server and are never sent to the browser.</p>
          <div className="list">
            {integrations.length === 0 && <div className="empty-note">Nothing connected yet.</div>}
            {integrations.map(i => (
              <div key={i.id} className="li"><span><b>{i.name}</b> <span className="sub">· {types.find(t => t.id === i.type)?.name ?? i.type} · {i.url}</span></span><button className="btn sm" onClick={() => edit(i)}>Edit</button></div>
            ))}
          </div>
          <h4 className="sec">Add a connection</h4>
          <div className="type-grid">{types.map(t => <button key={t.id} className="type-card" onClick={() => add(t)}><b>{t.name}</b><span>{t.description}</span></button>)}</div>
        </>
      ) : (
        <form className="form" onSubmit={e => { e.preventDefault(); void save(); }}>
          <p className="sub"><b>{type?.name}</b> · {type?.description}</p>
          <Field label="Name"><input value={form.name} onChange={e => set({ name: e.target.value })} maxLength={60} /></Field>
          <Field label="Address" hint="Where Homebase can reach the app, for example the server's IP and port."><input value={form.url} placeholder={type?.urlHint} onChange={e => set({ url: e.target.value })} autoComplete="off" /></Field>
          <Field label={type?.keyLabel ?? "API key"} hint={form.id ? "Leave blank to keep the saved key." : undefined}><input type="password" value={form.apiKey} onChange={e => set({ apiKey: e.target.value })} autoComplete="off" placeholder={form.id ? "••••••••" : ""} /></Field>
          <Field label="Refresh every (seconds)"><input type="number" min={5} max={3600} value={form.intervalSeconds} onChange={e => set({ intervalSeconds: Number(e.target.value) })} /></Field>
          <label className="chk"><input type="checkbox" checked={form.insecureTls} onChange={e => set({ insecureTls: e.target.checked })} /> Allow a self-signed certificate (https addresses only, common for UniFi)</label>
          {result && <p className={result.ok ? "ok-note" : "error"} role="status">{result.ok ? "✓ " : "✕ "}{result.message}</p>}
          <div className="acts">
            <span>{form.id && <button type="button" className="btn" onClick={remove} disabled={busy}>{confirmDelete ? "Click again to remove" : "Remove"}</button>}</span>
            <span className="acts-right"><button type="button" className="btn" onClick={() => setForm(null)}>Back</button><button type="button" className="btn" disabled={busy || !form.url} onClick={test}>Test connection</button><button className="btn pri" disabled={busy || !form.url || (!form.id && !form.apiKey)}>Save</button></span>
          </div>
        </form>
      )}
    </Modal>
  );
}
