import { useState } from "react";
import type { WidgetProps } from "./types";
import { Empty, Title } from "./common";

/** The tile shows go2rtc's own player (WebRTC with automatic fallbacks) in an iframe, proxied through Homebase. */
export function CameraPlayer({ cameraId, main }: { cameraId: string; main?: boolean }) {
  const src = `/go2rtc/stream.html?src=cam-${cameraId}${main ? "" : "-sub"}`;
  const [loaded, setLoaded] = useState(false);
  return (
    <div className="cam-frame">
      {!loaded && <div className="cam-loading">Connecting…</div>}
      <iframe title="Camera" src={src} loading="lazy" allow="autoplay; fullscreen" onLoad={() => setLoaded(true)} />
    </div>
  );
}

export function Camera({ tile, cameras, editing, openCamera, openSettings }: WidgetProps) {
  const cameraId = tile.config.cameraId as string | undefined;
  const cam = cameras.find(c => c.id === cameraId);
  if (!cameraId || !cam) {
    return (
      <>
        <Title>Camera</Title>
        <Empty>{cameraId ? "This camera was removed." : "No camera set up."}</Empty>
        {editing && <button className="btn sm" onClick={openSettings}>Set up camera</button>}
      </>
    );
  }
  return (
    <>
      <CameraPlayer cameraId={cameraId} />
      <div className="cov top"><span className="cname">{cam.name}</span></div>
      {!editing && <button className="cam-hit" aria-label={`Open ${cam.name}`} onClick={() => openCamera(cameraId)} />}
    </>
  );
}
