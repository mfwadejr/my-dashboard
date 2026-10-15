import type { CameraInfo } from "../types";
import { Modal } from "../dialogs/Modal";

export function CameraPick({ cameras, current, onPick, onAdd, onEdit, onClose }: {
  cameras: CameraInfo[]; current?: string; onPick: (id: string) => void; onAdd: () => void; onEdit: (id: string) => void; onClose: () => void;
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
      <div className="acts"><span /><button className="btn pri" onClick={onAdd}>＋ Add a camera</button></div>
    </Modal>
  );
}
