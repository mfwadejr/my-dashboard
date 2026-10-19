import type { CameraInfo } from "../types";
import { assignIcon } from "../api";
import { Field, Modal } from "../dialogs/Modal";
import { IconButton } from "./IconButton";
import { REFRESH_CHOICES, refreshOf } from "../widgets/Camera";

export function CameraPick({ cameras, current, config, onConfig, onPick, onAdd, onEdit, onClose, onChanged }: {
  cameras: CameraInfo[]; current?: string; config: Record<string, unknown>; onConfig: (patch: Record<string, unknown>) => void; onPick: (id: string) => void; onAdd: () => void; onEdit: (id: string) => void; onClose: () => void; onChanged?: () => void;
}) {
  return (
    <Modal title="Choose a camera" eyebrow="Camera tile" onClose={onClose}>
      <div className="list">
        {cameras.length === 0 && <div className="empty-note">No cameras yet.</div>}
        {cameras.map(c => (
          <div key={c.id} className="li">
            <IconButton icon={c.icon} iconRef={c.iconRef} name={c.name} size={22} onChange={async v => { await assignIcon("camera", c.id, v); onChanged?.(); }} /><span className="f1"><b>{c.name}</b>{c.id === current ? <span className="sub"> · showing</span> : null}</span>
            <span className="row"><button className="btn sm" onClick={() => onEdit(c.id)}>Edit</button><button className="btn sm pri" onClick={() => onPick(c.id)}>Use</button></span>
          </div>
        ))}
      </div>
      <div className="form mt12">
        <Field label="Show as" hint="Snapshots are a picture refreshed every few seconds. They use far less bandwidth than live video.">
          <select value={String(config.mode ?? "live")} onChange={e => onConfig({ mode: e.target.value })}><option value="live">Live video</option><option value="snapshot">Snapshot, refreshed</option></select>
        </Field>
        <Field label="Quality" hint="Each camera has a main stream (full resolution) and may have a lighter sub-stream. The picture opened full size always uses the main stream.">
          <select value={config.stream === "main" ? "main" : "sub"} onChange={e => onConfig({ stream: e.target.value })}><option value="sub">Light (sub-stream), easier on the network</option><option value="main">Full resolution (main stream)</option></select>
        </Field>
        {config.mode === "snapshot" && (
          <Field label="Refresh every"><select value={String(refreshOf(config.refresh))} onChange={e => onConfig({ refresh: Number(e.target.value) })}>{REFRESH_CHOICES.map(n => <option key={n} value={n}>{n} seconds</option>)}</select></Field>
        )}
      </div>
      <div className="acts"><span /><button className="btn pri" onClick={onAdd}>＋ Add a camera</button></div>
    </Modal>
  );
}
