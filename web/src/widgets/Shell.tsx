import type { ReactNode } from "react";
import type { IntegrationInfo, Snapshot } from "../types";
import type { WidgetProps } from "./types";
import { NeedsConnection } from "./Arr";
import { Empty, Live, Title } from "./common";

/** Shared frame for tiles that read one connection: handles "no connection", "loading", "no data yet" and stale data. */
export function Shell({ props, label, children }: { props: WidgetProps; label: string; children: (data: any, snap: Snapshot, info: IntegrationInfo) => ReactNode }) {
  const id = props.tile.config.integrationId as string | undefined;
  const info = props.integrations.find(i => i.id === id);
  const snap = id ? props.snapshots[id] : undefined;
  if (!id || !info) return <NeedsConnection label={label} editing={props.editing} openSettings={props.openSettings} missing={Boolean(id)} />;
  const title = String(props.tile.config.title || info.name);
  if (!snap) return <><Title right={<Live ok={false} />}>{title}</Title><Empty>Loading…</Empty></>;
  if (!snap.data) return <><Title right={<Live ok={false} />}>{title}</Title><Empty>{snap.error ?? "No data yet"}</Empty></>;
  return (
    <>
      <Title right={<Live ok={snap.ok} stale />}>{title}</Title>
      {!snap.ok && <div className="stale-note" title={snap.error ?? ""}>Showing last known data · {snap.error}</div>}
      {children(snap.data, snap, info)}
    </>
  );
}

export const rate = (bps: number | null | undefined): string => {
  if (typeof bps !== "number") return "–";
  if (bps >= 1e9) return `${(bps / 1e9).toFixed(1)} Gbps`;
  if (bps >= 1e6) return `${(bps / 1e6).toFixed(1)} Mbps`;
  return `${Math.round(bps / 1e3)} kbps`;
};
export const pct = (n: number | null | undefined) => (typeof n === "number" ? `${Math.round(n)}%` : "–");
export const uptime = (sec: number | null | undefined): string => {
  if (typeof sec !== "number") return "–";
  const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600);
  return d ? `${d}d ${h}h` : `${h}h ${Math.floor((sec % 3600) / 60)}m`;
};

export function bytes(b: number | null | undefined): string {
  if (typeof b !== "number") return "–";
  const u = ["B", "KB", "MB", "GB", "TB", "PB"]; let i = 0, v = b;
  while (v >= 1000 && i < u.length - 1) { v /= 1000; i++; }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${u[i]}`;
}
