import { useEffect, useState } from "react";
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

/**
 * A still picture from go2rtc, refreshed every few seconds. Much lighter than live video, which matters when many cameras are on screen.
 * The next picture is fetched in the background and swapped in, so there is no flicker; polling pauses while the page is hidden.
 */
export function CameraSnapshot({ cameraId, refreshSec, main }: { cameraId: string; refreshSec: number; main?: boolean }) {
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let stop = false, timer = 0, current: string | null = null;
    const ctl = new AbortController();
    const next = (ms: number) => { if (!stop) timer = window.setTimeout(load, ms); };
    const load = async () => {
      if (stop) return;
      if (document.hidden) return next(2000);
      try {
        const res = await fetch(`/go2rtc/api/frame.jpeg?src=cam-${cameraId}${main ? "" : "-sub"}&t=${Date.now()}`, { credentials: "same-origin", signal: ctl.signal });
        if (!res.ok || !(res.headers.get("content-type") ?? "").startsWith("image/")) throw new Error("no picture");
        const url = URL.createObjectURL(await res.blob());
        if (stop) { URL.revokeObjectURL(url); return; }
        if (current) URL.revokeObjectURL(current);
        current = url; setSrc(url); setFailed(false); next(refreshSec * 1000);
      } catch { if (!stop) { setFailed(true); next(Math.max(refreshSec, 10) * 1000); } }
    };
    void load();
    return () => { stop = true; ctl.abort(); window.clearTimeout(timer); if (current) URL.revokeObjectURL(current); };
  }, [cameraId, refreshSec, main]);
  return (
    <div className="cam-frame">
      {src ? <img className={`cam-still${failed ? " stale" : ""}`} src={src} alt="" /> : <div className="cam-loading">{failed ? "No picture" : "Loading…"}</div>}
      {src && failed && <div className="cam-off">Offline</div>}
    </div>
  );
}

/** One camera, either as live video or as a refreshing still, depending on the tile's setting. */
export function CameraFeed({ cameraId, mode, refreshSec, main }: { cameraId: string; mode: string; refreshSec: number; main?: boolean }) {
  return mode === "snapshot" ? <CameraSnapshot cameraId={cameraId} refreshSec={refreshSec} main={main} /> : <CameraPlayer cameraId={cameraId} main={main} />;
}

export const REFRESH_CHOICES = [5, 10, 30, 60];
export const refreshOf = (v: unknown) => (REFRESH_CHOICES.includes(Number(v)) ? Number(v) : 10);

export function Camera({ tile, cameras, editing, openCamera, openSettings }: WidgetProps) {
  const cameraId = tile.config.cameraId as string | undefined;
  const cam = cameras.find(c => c.id === cameraId);
  if (!cameraId || !cam) {
    return (
      <div className="cam-empty">
        <Title>Camera</Title>
        <Empty>{cameraId ? "This camera was removed." : "No camera set up."}</Empty>
        {editing && <button className="btn sm" onClick={openSettings}>Set up camera</button>}
      </div>
    );
  }
  return (
    <>
      <CameraFeed cameraId={cameraId} mode={String(tile.config.mode ?? "live")} refreshSec={refreshOf(tile.config.refresh)} main={tile.config.stream === "main"} />
      <div className="cov top"><span className="cname">{cam.name}</span></div>
      {!editing && <button className="cam-hit" aria-label={`Open ${cam.name}`} onClick={() => openCamera(cameraId)} />}
    </>
  );
}
