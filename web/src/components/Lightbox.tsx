import { useState } from "react";
import type { CameraInfo } from "../types";
import { CameraPlayer } from "../widgets/Camera";
import { Modal } from "../dialogs/Modal";

export function Lightbox({ cameraId, cameras, onClose }: { cameraId: string; cameras: CameraInfo[]; onClose: () => void }) {
  const [id, setId] = useState(cameraId);
  const cam = cameras.find(c => c.id === id);
  const index = cameras.findIndex(c => c.id === id);
  const step = (d: number) => cameras.length && setId(cameras[(index + d + cameras.length) % cameras.length].id);
  return (
    <Modal title={cam?.name ?? "Camera"} eyebrow="Live" onClose={onClose} wide>
      <div className="lbv tile cam"><CameraPlayer key={id} cameraId={id} main /></div>
      {cameras.length > 1 && <div className="acts"><button className="btn" onClick={() => step(-1)}>◀ Previous</button><button className="btn" onClick={() => step(1)}>Next ▶</button></div>}
    </Modal>
  );
}
