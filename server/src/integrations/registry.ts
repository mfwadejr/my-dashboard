import { radarr, sonarr } from "./arr.js";
import { sabnzbd } from "./sabnzbd.js";
import type { IntegrationType } from "./types.js";

/** Adding an app = write one file that exports an IntegrationType, then list it here. */
export const INTEGRATION_TYPES: Record<string, IntegrationType> = Object.fromEntries(
  [sonarr, radarr, sabnzbd].map(type => [type.id, type])
);

export function publicTypeInfo() {
  return Object.values(INTEGRATION_TYPES).map(({ id, name, description, urlHint, keyLabel }) => ({ id, name, description, urlHint, keyLabel }));
}
