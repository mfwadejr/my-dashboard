/** Sections a tile can show. A tile's config keeps them as an ordered list of {id, on}. */
export interface SectionDef { id: string; label: string; hint: string; on: boolean }
export type SectionState = Array<{ id: string; on: boolean }>;

export const SECTION_DEFS: Record<string, SectionDef[]> = {
  "unifi-network": [
    { id: "summary", label: "Summary", hint: "Clients, devices up, wireless clients", on: true },
    { id: "gateway", label: "Gateway", hint: "Name, uptime, CPU, RAM, temperature and total WAN rate", on: true },
    { id: "wans", label: "WAN links", hint: "Each internet connection with its state, address and throughput", on: false },
    { id: "speedtest", label: "Last speed test", hint: "Result of the gateway's most recent speed test", on: false },
    { id: "aps", label: "Access points", hint: "Each access point with its connected clients", on: false },
    { id: "wifi", label: "Wi-Fi networks", hint: "Each SSID and whether it is enabled", on: false },
    { id: "networks", label: "Networks / VLANs", hint: "Each network with its VLAN id", on: false },
    { id: "devices", label: "All devices", hint: "Every UniFi device with state and firmware-update flag", on: false },
    { id: "problems", label: "Offline devices", hint: "Devices that are not online (or an all-clear line)", on: true }
  ],
  sonarr: [
    { id: "summary", label: "Summary", hint: "In queue, missing and health counts, with the first health warning", on: true },
    { id: "queue", label: "Queue", hint: "Current downloads with progress, quality and client; stalled or failed ones are flagged", on: true },
    { id: "upcoming", label: "Coming up", hint: "What is due in the next two weeks", on: true },
    { id: "recent", label: "Recently added", hint: "The last episodes that finished and were imported", on: false },
    { id: "library", label: "Library", hint: "Series count, how many are monitored, and quality upgrades wanted", on: false },
    { id: "disk", label: "Disk space", hint: "Free space on the drives this app uses", on: false }
  ],
  radarr: [
    { id: "summary", label: "Summary", hint: "In queue, missing and health counts, with the first health warning", on: true },
    { id: "queue", label: "Queue", hint: "Current downloads with progress, quality and client; stalled or failed ones are flagged", on: true },
    { id: "upcoming", label: "Coming up", hint: "What is due in the next two weeks", on: true },
    { id: "recent", label: "Recently added", hint: "The last movies that finished and were imported", on: false },
    { id: "library", label: "Library", hint: "Movie count, how many are monitored, and quality upgrades wanted", on: false },
    { id: "disk", label: "Disk space", hint: "Free space on the drives this app uses", on: false }
  ],
  sabnzbd: [
    { id: "summary", label: "Summary", hint: "Speed, queue size and time left, status and warnings, pause button", on: true },
    { id: "graph", label: "Speed graph", hint: "Download speed over the last few hours", on: true },
    { id: "queue", label: "Queue", hint: "Current downloads with progress; pause or remove one job when signed in", on: true },
    { id: "disk", label: "Download disk", hint: "Free space on the download drive", on: true },
    { id: "limit", label: "Speed limit", hint: "Current limit, and change it when signed in", on: false },
    { id: "history", label: "History", hint: "Recent finished and failed jobs, retry a failed one, totals for today and this week", on: true }
  ],
  prowlarr: [
    { id: "summary", label: "Summary", hint: "Enabled, blocked and grab counts, with the first health warning", on: true },
    { id: "stats", label: "Failure stats", hint: "Success rate, failed searches and failed grabs", on: true },
    { id: "blocked", label: "Blocked indexers", hint: "Indexers Prowlarr has paused after failures, and until when", on: true },
    { id: "top", label: "Busiest indexers", hint: "Most-used indexers with queries and response time", on: true },
    { id: "indexers", label: "All indexers", hint: "Every indexer with state, usenet or torrent, priority and failure rate", on: false },
    { id: "recent", label: "Recent searches", hint: "Latest searches and grabs with the indexer and whether they worked", on: false },
    { id: "test", label: "Test button", hint: "Run Prowlarr's test of all indexers (when signed in)", on: false }
  ],
  zimaos: [
    { id: "summary", label: "CPU, RAM and temperature", hint: "Headline numbers with a memory bar", on: true },
    { id: "network", label: "Network", hint: "Upload and download speed of the main network port, with a short history graph", on: false },
    { id: "systemdisk", label: "System disk", hint: "Used and total space on the system drive", on: true },
    { id: "appcount", label: "App count", hint: "How many apps are running", on: true },
    { id: "apps", label: "App list", hint: "Every installed app with its state", on: false },
    { id: "containers", label: "Containers", hint: "Docker containers with their state", on: false },
    { id: "vms", label: "Virtual machines", hint: "Virtual machines with their state", on: false },
    { id: "disks", label: "Storage disks", hint: "Each drive with size and temperature", on: true }
  ]
};

/** Saved order first, then any section the saved list does not know about (for example one added in a later version). */
export function resolveSections(type: string, saved: unknown): SectionState {
  const defs = SECTION_DEFS[type] ?? [];
  const known = new Set(defs.map(s => s.id));
  const out: SectionState = [];
  const seen = new Set<string>();
  if (Array.isArray(saved)) for (const s of saved) if (s && known.has(s.id) && !seen.has(s.id)) { seen.add(s.id); out.push({ id: s.id, on: s.on === true }); }
  for (const s of defs) if (!seen.has(s.id)) out.push({ id: s.id, on: s.on });
  return out;
}
