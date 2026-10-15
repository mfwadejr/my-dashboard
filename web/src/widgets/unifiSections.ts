/** Sections the UniFi Network tile can show. The tile's config keeps them as an ordered list of {id, on}. */
export interface UnifiSection { id: string; label: string; hint: string; on: boolean }

export const UNIFI_SECTIONS: UnifiSection[] = [
  { id: "summary", label: "Summary", hint: "Clients, devices up, wireless clients", on: true },
  { id: "gateway", label: "Gateway", hint: "Name, uptime, CPU, RAM, temperature and total WAN rate", on: true },
  { id: "wans", label: "WAN links", hint: "Each internet connection with its state, address and throughput", on: false },
  { id: "speedtest", label: "Last speed test", hint: "Result of the gateway's most recent speed test", on: false },
  { id: "aps", label: "Access points", hint: "Each access point with its connected clients", on: false },
  { id: "wifi", label: "Wi-Fi networks", hint: "Each SSID and whether it is enabled", on: false },
  { id: "networks", label: "Networks / VLANs", hint: "Each network with its VLAN id", on: false },
  { id: "devices", label: "All devices", hint: "Every UniFi device with state and firmware-update flag", on: false },
  { id: "problems", label: "Offline devices", hint: "Devices that are not online (or an all-clear line)", on: true }
];

export type SectionState = Array<{ id: string; on: boolean }>;

/** Saved order first, then any section the saved list does not know about (for example one added in a later version). */
export function resolveSections(saved: unknown): SectionState {
  const known = new Map(UNIFI_SECTIONS.map(s => [s.id, s]));
  const out: SectionState = [];
  const seen = new Set<string>();
  if (Array.isArray(saved)) for (const s of saved) if (s && known.has(s.id) && !seen.has(s.id)) { seen.add(s.id); out.push({ id: s.id, on: s.on === true }); }
  for (const s of UNIFI_SECTIONS) if (!seen.has(s.id)) out.push({ id: s.id, on: s.on });
  return out;
}
