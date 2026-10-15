import type { ReactElement } from "react";
import type { CameraInfo, IntegrationInfo, Snapshot, Tile } from "../types";

export interface WidgetProps {
  tile: Tile;
  editing: boolean;
  authed: boolean;
  snapshots: Record<string, Snapshot>;
  integrations: IntegrationInfo[];
  cameras: CameraInfo[];
  query: string;
  setConfig: (patch: Record<string, unknown>) => void;
  openCamera: (cameraId: string) => void;
  openSettings: () => void;
  refreshIntegrations: () => void;
}

export interface WidgetDef {
  type: string;
  label: string;
  description: string;
  size: [number, number];
  /** Integration type this tile reads from, if any. */
  needs?: string | string[];
  component: (props: WidgetProps) => ReactElement | null;
}
