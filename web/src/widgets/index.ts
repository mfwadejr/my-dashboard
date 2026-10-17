import { Arr } from "./Arr";
import { Camera } from "./Camera";
import { CameraWall } from "./CameraWall";
import { Clock } from "./Clock";
import { Launcher } from "./Launcher";
import { MediaCalendar } from "./MediaCalendar";
import { Notes } from "./Notes";
import { Pdu } from "./Pdu";
import { Prowlarr } from "./Prowlarr";
import { Sab } from "./Sab";
import { SiteGateway } from "./SiteGateway";
import { UnifiNetwork, UnifiProtect, UnifiUnas } from "./Unifi";
import { Unraid } from "./Unraid";
import { Zima } from "./Zima";
import type { WidgetDef } from "./types";

/** Adding a tile type = one component here plus its name in server/src/dashboard.ts TILE_TYPES. */
export const WIDGETS: WidgetDef[] = [
  { type: "launcher", label: "App launcher", description: "Links with icons and status dots", size: [4, 2], component: Launcher },
  { type: "sonarr", label: "Sonarr", description: "TV queue, missing and upcoming", size: [3, 3], needs: "sonarr", component: Arr },
  { type: "radarr", label: "Radarr", description: "Movie queue, missing and upcoming", size: [3, 3], needs: "radarr", component: Arr },
  { type: "mediacalendar", label: "Media calendar", description: "Sonarr and Radarr in one month view", size: [4, 5], component: MediaCalendar },
  { type: "sabnzbd", label: "SABnzbd", description: "Downloads, speed and pause", size: [3, 3], needs: "sabnzbd", component: Sab },
  { type: "prowlarr", label: "Prowlarr", description: "Indexer health, blocked indexers, grabs", size: [3, 3], needs: "prowlarr", component: Prowlarr },
  { type: "sitegateway", label: "Site Gateway", description: "Gateway, sites, proxies, certificates, alerts", size: [3, 3], needs: "sitegateway", component: SiteGateway },
  { type: "unifi-network", label: "UniFi Network", description: "Clients, devices, gateway load and WAN rate", size: [3, 3], needs: "unifi-network", component: UnifiNetwork },
  { type: "unifi-protect", label: "UniFi Protect", description: "Cameras connected or offline", size: [3, 2], needs: "unifi-protect", component: UnifiProtect },
  { type: "unifi-unas", label: "UniFi UNAS", description: "Storage used and free", size: [2, 3], needs: "unifi-unas", component: UnifiUnas },
  { type: "unifi-pdu", label: "UniFi PDU", description: "Power draw and outlet states", size: [3, 3], needs: ["unifi-network", "unifi-pdu"], component: Pdu },
  { type: "unraid", label: "Unraid", description: "Array, disks, Docker, VMs, CPU and memory", size: [3, 4], needs: "unraid", component: Unraid },
  { type: "zimaos", label: "ZimaOS", description: "CPU, memory, storage, apps, updates", size: [3, 3], needs: "zimaos", component: Zima },
  { type: "camera", label: "Camera", description: "Live camera feed through go2rtc", size: [2, 2], component: Camera },
  { type: "camerawall", label: "Camera wall", description: "Several cameras in one tile, stills or live", size: [6, 4], component: CameraWall },
  { type: "clock", label: "Clock", description: "Time and date", size: [2, 1], component: Clock },
  { type: "notes", label: "Notes", description: "A sticky note", size: [2, 2], component: Notes }
];

export const WIDGET_BY_TYPE = Object.fromEntries(WIDGETS.map(w => [w.type, w]));
