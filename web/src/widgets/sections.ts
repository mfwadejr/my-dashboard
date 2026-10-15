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
  zimaos: [
    { id: "summary", label: "CPU, RAM and temperature", hint: "Headline numbers with a memory bar", on: true },
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
