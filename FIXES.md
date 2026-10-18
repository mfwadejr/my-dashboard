# Fix list

Small fixes and follow-ups, newest first. Move an item to Done when it ships.

## Backend: finished (items 1-20 shipped in update33, update34 and update35).

## After the backend: search, launcher and opening services (agreed in discussion, not built yet)
- Framing check: when a connection is saved or tested, the server reads the service's response headers and says either "This can be shown inside Homebase" or "This service blocks being shown inside other pages, so it will open in a new tab". If framing is blocked (or https page + http service), opening quietly falls back to a new tab. No proxying of services through Homebase.
- Global search (press /): tiles, links, connections, cameras, settings pages; later live data.
- Launcher: bigger built-in icon library with auto-match by name, groups/tags, optional up/down dot per link (checked by the server, admin-entered addresses only).
- Then: generic custom-API connection (address, auth header, chosen fields) and a shared "service status" tile; integrations in batches of five or six chosen from what Marvin runs (Plex/Jellyfin/Seerr first), verified before the next batch; look and feel (background image, themes, admin-only custom CSS); tab visibility per person before full boards. Translations and Docker discovery stay later.

## Open
- Platform follow-ups: external alerts (ntfy/Discord/webhook) deferred by choice; OIDC sign-in; per-person permissions beyond Admin/Viewer; UI restore of a database copy (today: stop the container and replace homebase.db).
- Competitor gaps to schedule: global search across tiles and links, bookmarks tile with icon library, up/down dots on any link, multiple boards, themes and background image, more integrations (Plex/Jellyfin/Seerr, Pi-hole, Proxmox, Home Assistant, qBittorrent), translations, Docker label auto-discovery.
- Unraid network graph like ZimaOS: waiting on what this Unraid version exposes. Press Test on the Unraid connection and note the "Network-related fields" line.

- ZimaOS Storage: ZimaOS's own widget shows health, used and total for the storage pool; Homebase lists drives only.
- UniFi UNAS: connection signs in with a local account (as Homepage does) and tries likely /proxy/drive addresses; confirm against a real UNAS with the connection Test result and adjust.
- ZimaOS containers/VMs: confirm which endpoints your system answers (connection Test lists what is readable).
- Verify against real hardware: Protect, Prowlarr, Site Gateway, Unraid, ZimaOS.

## Done
- update41: Settings → Data & backup is split into four tabs (Backups, Export & restore, History & log, Upkeep & reset) so it no longer scrolls forever; the last tab used is remembered for the session.
- update40: Select all / Select none when importing cameras from UniFi Protect and when choosing the cameras for a camera wall.
- update39: empty camera and camera-wall tiles (no camera chosen, or the camera was removed) have proper padding instead of text touching the edge.
- update38: camera tiles and camera walls get a Quality choice (light sub-stream, or full-resolution main stream); the picture opened full size still always uses the main stream.
- update37: "Copy link" (share links, API tokens, recovery codes) now works when Homebase is opened over plain http on a home network, where browsers disable the clipboard API; ZimaOS compose file gained the app-store details and both ports.
- update36: open address per connection (the address your browser uses, separate from the one Homebase uses; optional, opens in a new tab or inside Homebase); in-app opening with a server-side check of whether the app allows being framed (clear reason and a new-tab button when it does not); an Open ↗ button on connection tiles and in the connection list; per-link "Inside Homebase" option in the Launcher; global search (/ or Ctrl/Cmd+K) across tabs, tiles, Launcher links, connections, cameras and settings pages.
- update35 (push 3 of 3, icons): an icon picker everywhere an icon is used (connections, tabs, tiles, cameras, Launcher items, people, API tokens) with search across Dashboard Icons, selfh.st and Lucide, upload, image address and "use letters instead"; storage choice reviewed once in Settings → Icons (search only, search and cache, mirror one format, mirror every format) with daily refresh, per-library Sync now and status; chosen icons are frozen copies in icons/used/ that never change by themselves, with an "updated icons" list and one-click update; older Launcher icons moved once after a verified database copy; Complete backup (database plus saved icons in one .tar.gz), icons bundled in the JSON export, and Verify checking them.
- update34 (push 2 of 3, backend): two-factor sign-in (authenticator app, QR code, 10 one-time recovery codes; an admin can reset someone's; `HOMEBASE_RESET_2FA=<username>` clears it from the container) and idle sign-out for admins; API tokens (Settings → API access: read-only or read-write, shown once, revocable, last use recorded, every use logged under the area "api", 600 requests a minute, never able to manage people, backups, sharing or tokens, plus a flat `/api/summary` for other tools); graph history kept in three tiers (full detail, hourly, daily averages) with a preview before pruning; log rules by severity, by area and by size, optional CSV of removed lines, quiet/normal/detailed recording; database upkeep (integrity check, search-index refresh, vacuum, table sizes) weekly, monthly or on demand; disk-space warnings on the Status page; a fuller health check (database writable, disk, relay); optional daily update check against GitHub (off by default).
- update33 (push 1 of 3, backend): restore from the UI (verified first, safety copy, swap at restart); Verify on every copy and "Verify a file..." for .db and .json (database opens, integrity and foreign keys, layout version, counts, saved passwords open with the current key, admin exists, date and size; scheduled copies are verified and logged); schedule control (6 hours, daily, weekly, time of day, next copy shown); network copies over SFTP (built in, server identity pinned on first Test) and SMB (smbclient in the image; untested against a real NAS); safety copy before every database layout upgrade and refusal to start on a newer database; accounts as an opt-in in the JSON backup (passphrase required); "Add a copy from a file".
- Platform pass (update32): Settings page with General (name, time zone, clock, week start, public address, appearance moved out of the header with dashboard default and per-device override, wall display, history limits), Data & backup (JSON export with optional passphrase, restore with preview, nightly SQLite copies, encryption key download, danger zone), Access (Admin/Viewer accounts, password change, signed-in devices), Sharing (camera links with expiry, PIN, switch off; wall-display links), Status & log (per-connection state and 24 h strip, searchable plain-English log with filters and CSV export) and About. Version, commit and build date baked into the image, shown in the footer, About and health check; open pages show a reload banner after an update. No anonymous viewing. Public port 3001 serves share links only. Wall display mode, tab cycling, wake lock and a PWA manifest.
- Tiles can be placed anywhere by dragging in edit mode: snap-to-grid with a landing outline, other tiles make room, drag between groups, per-group Auto-pack, Esc cancels, edge auto-scroll; the Arrange presets are one-time buttons and moving a tile switches the group back to Free.
- Cameras: Test button (connects through go2rtc and shows a picture or a plain-language reason), snapshot mode (refreshed stills), a Camera wall tile (several cameras, stills or live), and import of cameras from a UniFi Protect connection.
- Cameras: UniFi Protect secure links (rtsps://…:7441/…?enableSrtp) are converted to plain RTSP (port 7447) automatically, in the dialog and on the server.
- Unraid: pick-and-order sections, CPU/RAM gauges and history, container and VM lists with start/stop/restart (signed in, asks first), parity check progress and last result, share usage.
- Site Gateway: pick-and-order sections, full attention list (critical first), traffic graph, upstreams and streams, certificate expiry, version and public address.
- Prowlarr: pick-and-order sections, failure stats (success %, failed searches/grabs), full indexer list (state, protocol, priority, failure rate), recent searches and grabs, and a Test all indexers button.
- Sonarr/Radarr: pick-and-order sections (summary, queue, upcoming, recently grabbed, library, disk), stuck-download warnings with reasons, quality and client per item.
- Media calendar tile: one month grid across any number of Sonarr and Radarr connections, posters, downloaded state, Radarr cinema/digital/physical dates, day detail and list view.

- SABnzbd tile: section picker (summary, speed graph, queue, download disk, speed limit, history); status and warnings pills; pause/resume/remove per job; retry failed history; speed limit control; today/week totals.
- UniFi UNAS connection and tile (storage used/free gauge) built; unverified on real hardware.
- ZimaOS tile: live Network graph like ZimaOS's own (2-second samples, grid, smooth filled curves). Sampling runs only while a browser has the tile open.
- ZimaOS tile: CPU and RAM shown as arc gauges like ZimaOS's own System widget (CPU shows power and temperature, RAM shows used of total); unlabeled memory bar removed.
- ZimaOS tile: choose and order sections; app list, containers and VMs (container/VM endpoints are best-effort until checked on a real system).
- UniFi Network tile: choose and order sections (summary, gateway, WAN links with per-WAN rates, speed test, access points, Wi-Fi, VLANs, all devices, offline devices).
- PDU: USB outlets show "Not metered by this PDU" on hover (they report `outlet_caps=1`, no power data).
- PDU: watts, voltage, current, outlet icons colored by state and load.
