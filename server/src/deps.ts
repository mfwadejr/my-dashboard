import type { Access } from "./access.js";
import type { AutoBackup } from "./backup.js";
import type { Config } from "./config.js";
import type { SecretBox } from "./crypto.js";
import type { DB } from "./db.js";
import type { Destinations } from "./destinations.js";
import type { Go2rtc } from "./go2rtc.js";
import type { Hub } from "./hub.js";
import type { Poller } from "./poller.js";
import type { Shares } from "./shares.js";
import type { Store } from "./store.js";

/** Everything the route files need, passed as one object. */
export interface Deps {
  config: Config; db: DB; box: SecretBox; store: Store; hub: Hub; poller: Poller; go2rtc: Go2rtc;
  shares: Shares; access: Access; backups: AutoBackup; destinations: Destinations;
  /** Ends the process so the container restarts (used after a restore). Replaced in index.ts; does nothing in tests. */
  restart: () => void;
}
