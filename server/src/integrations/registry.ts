import { radarr, sonarr } from "./arr.js";
import { prowlarr } from "./prowlarr.js";
import { sabnzbd } from "./sabnzbd.js";
import { siteGateway } from "./sitegateway.js";
import { unraid } from "./unraid.js";
import { zimaos } from "./zimaos.js";
import { unifiUnas } from "./unas.js";
import { unifiNetwork, unifiPdu, unifiProbe, unifiProtect } from "./unifi.js";
import type { IntegrationType } from "./types.js";

/** Adding an app = write one file that exports an IntegrationType, then list it here. */
export const INTEGRATION_TYPES: Record<string, IntegrationType> = Object.fromEntries(
  [sonarr, radarr, prowlarr, sabnzbd, siteGateway, unifiNetwork, unifiPdu, unifiProtect, unifiProbe, unraid, zimaos, unifiUnas].map(type => [type.id, type])
);

export function publicTypeInfo() {
  return Object.values(INTEGRATION_TYPES).map(({ id, name, description, urlHint, keyLabel }) => ({ id, name, description, urlHint, keyLabel }));
}
