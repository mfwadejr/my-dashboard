import { Arr } from "./Arr";
import { Camera } from "./Camera";
import { Clock } from "./Clock";
import { Launcher } from "./Launcher";
import { Notes } from "./Notes";
import { Sab } from "./Sab";
import type { WidgetDef } from "./types";

/** Adding a tile type = one component here plus its name in server/src/dashboard.ts TILE_TYPES. */
export const WIDGETS: WidgetDef[] = [
  { type: "launcher", label: "App launcher", description: "Links with icons and status dots", size: [4, 2], component: Launcher },
  { type: "sonarr", label: "Sonarr", description: "TV queue, missing and upcoming", size: [3, 3], needs: "sonarr", component: Arr },
  { type: "radarr", label: "Radarr", description: "Movie queue, missing and upcoming", size: [3, 3], needs: "radarr", component: Arr },
  { type: "sabnzbd", label: "SABnzbd", description: "Downloads, speed and pause", size: [3, 3], needs: "sabnzbd", component: Sab },
  { type: "camera", label: "Camera", description: "Live camera feed through go2rtc", size: [2, 2], component: Camera },
  { type: "clock", label: "Clock", description: "Time and date", size: [2, 1], component: Clock },
  { type: "notes", label: "Notes", description: "A sticky note", size: [2, 2], component: Notes }
];

export const WIDGET_BY_TYPE = Object.fromEntries(WIDGETS.map(w => [w.type, w]));
