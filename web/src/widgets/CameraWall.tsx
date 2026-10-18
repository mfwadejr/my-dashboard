import type { WidgetProps } from "./types";
import { Empty, Title } from "./common";
import { CameraFeed, refreshOf } from "./Camera";

/** Several cameras in one tile. Stills by default, because many live streams at once are heavy on the network and the browser. */
export function CameraWall({ tile, cameras, editing, openCamera, openSettings }: WidgetProps) {
  const ids = ((tile.config.cameraIds ?? []) as string[]).filter(id => cameras.some(c => c.id === id));
  if (ids.length === 0) {
    return (
      <div className="wall-empty">
        <Title>{String(tile.config.title || "Camera wall")}</Title>
        <Empty>Choose which cameras to show.</Empty>
        {editing && <button className="btn sm" onClick={openSettings}>Choose cameras</button>}
      </div>
    );
  }
  const cols = ids.length <= 1 ? 1 : ids.length <= 4 ? 2 : ids.length <= 9 ? 3 : 4;
  const mode = String(tile.config.mode ?? "snapshot"), refreshSec = refreshOf(tile.config.refresh);
  return (
    <div className="wall" style={{ gridTemplateColumns: `repeat(${cols}, 1fr)` }}>
      {ids.map(id => {
        const cam = cameras.find(c => c.id === id)!;
        return (
          <div key={id} className="wall-cell">
            <CameraFeed cameraId={id} mode={mode} refreshSec={refreshSec} main={tile.config.stream === "main"} />
            <div className="cov top"><span className="cname">{cam.name}</span></div>
            {!editing && <button className="cam-hit" aria-label={`Open ${cam.name}`} onClick={() => openCamera(id)} />}
          </div>
        );
      })}
    </div>
  );
}
