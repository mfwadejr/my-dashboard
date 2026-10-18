# Fix list

Small fixes and follow-ups, newest first. Move an item to Done when it ships.

## Next: finish the backend first (agreed; before more tiles or integrations). Items 1-6 shipped in update33; numbering below continues from 7.
Log and history
7. Log pruning rules: keep by severity (errors/warnings longer than information), size cap (oldest first), per-area retention, optional export of old lines to a file before pruning, and verbosity (how much is written).
8. Graph history downsampling: detailed readings for about 2 days, hourly averages for 30 days, daily averages for a year (instead of keep-everything or delete).
Security and access
9. Two-factor sign-in (TOTP) for admins with recovery codes, plus an idle timeout.
10. API tokens (new Settings tab): named, read-only or read-write, shown once, revocable, last-used shown, every use logged.
Health and maintenance
11. Database maintenance: periodic integrity check, vacuum, size report; warning on the Status page when the disk is nearly full.
12. Fuller health check for the container healthcheck: database writable, disk space, relay reachable.
13. Optional update check against GitHub shown in About; off by default (it makes an outside request).
Icons (modelled on Site Gateway v0.16.x, reviewed from the code)
14. Icon selector everywhere an icon is used (connections, tiles, tabs, cameras, Launcher, accounts, API tokens): search, upload, https address, "use letters instead", one-click clear.
15. Three icon sources in one search, saved as source:slug references: Dashboard Icons (app logos), selfh.st Icons (more app logos), Lucide (plain symbols such as camera, router, wifi). Lucide symbols are recolored for the dark theme when stored. Light/dark variants hidden from broad search but still found by exact name.
16. Local icon mirror in the data folder with a database index (source, slug, format, content hash, tags, categories): background sync at startup and daily, "Sync now" and per-source status line in the picker, picker waits with a "building the library" message on first run. Icons removed upstream stay usable if already saved.
17. Icon library storage tiers chosen in Settings (reviewed once before the picker unlocks): Search-only (~5 MB), Search with local cache (~200 MB cap, recommended), Full mirror one format per icon (~350 MB, fully offline), Full mirror every format (~1.1 GB).
18. Saved icons are frozen copies in icons/used/ (never change silently), with the content hash in the URL for cache-busting, plus an "update available" badge and one-click refresh when the upstream file has changed.
19. Icon migration for Homebase's existing icons (Launcher items use flat files and di:slug references): one-time, idempotent, with a verified database copy first, then move to icons/used/ and rewrite references.
20. Icons included in backups: Complete backup carries icons/used/ (not the big mirror, which re-downloads); JSON export bundles the used icon files; Verify checks every referenced icon exists.

## After the backend: search, launcher and opening services (agreed in discussion, not built yet)
- Open address: each connection gets a second field, "Open address (what your browser uses)", separate from the address the server uses.
- Opening: an Open action on every connection tile, the Launcher, the connection list and search results. Per connection: new tab, inside Homebase (full panel with close button), or the dashboard default (General setting). Inside Homebase is preferred wherever the service allows it.
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
