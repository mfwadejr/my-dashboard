import type { CameraInfo } from "../types";
import { Field, Modal } from "../dialogs/Modal";
import { REFRESH_CHOICES, refreshOf } from "../widgets/Camera";

export function CameraPick({ cameras, current, config, onConfig, onPick, onAdd, onEdit, onClose }: {
  cameras: CameraInfo[]; current?: string; config: Record<string, unknown>; onConfig: (patch: Record<string, unknown>) => void; onPick: (id: string) => void; onAdd: () => void; onEdit: (id: string) => void; onClose: () => void;
}) {
  return (
    <Modal title="Choose a camera" eyebrow="Camera tile" onClose={onClose}>
      <div className="list">
        {cameras.length === 0 && <div className="empty-note">No cameras yet.</div>}
        {cameras.map(c => (
          <div key={c.id} className="li">
            <span><b>{c.name}</b>{c.id === current ? <span className="sub"> · showing</span> : null}</span>
            <span className="row"><button className="btn sm" onClick={() => onEdit(c.id)}>Edit</button><button className="btn sm pri" onClick={() => onPick(c.id)}>Use</button></span>
          </div>
        ))}
      </div>
      <div className="form" style={{ marginTop: 12 }}>
        <Field label="Show as" hint="Snapshots are a picture refreshed every few seconds. They use far less bandwidth than live video.">
          <select value={String(config.mode ?? "live")} onChange={e => onConfig({ mode: e.target.value })}><option value="live">Live video</option><option value="snapshot">Snapshot, refreshed</option></select>
        </Field>
        {config.mode === "snapshot" && (
          <Field label="Refresh every"><select value={String(refreshOf(config.refresh))} onChange={e => onConfig({ refresh: Number(e.target.value) })}>{REFRESH_CHOICES.map(n => <option key={n} value={n}>{n} seconds</option>)}</select></Field>
        )}
      </div>
      <div className="acts"><span /><button className="btn pri" onClick={onAdd}>＋ Add a camera</button></div>
    </Modal>
  );
}
