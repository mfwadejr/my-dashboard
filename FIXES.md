# Fix list

Small fixes and follow-ups, newest first. Move an item to Done when it ships.

## Open
- Platform follow-ups: external alerts (ntfy/Discord/webhook) deferred by choice; OIDC sign-in; per-person permissions beyond Admin/Viewer; UI restore of a database copy (today: stop the container and replace homebase.db).
- Competitor gaps to schedule: global search across tiles and links, bookmarks tile with icon library, up/down dots on any link, multiple boards, themes and background image, more integrations (Plex/Jellyfin/Seerr, Pi-hole, Proxmox, Home Assistant, qBittorrent), translations, Docker label auto-discovery.
- Unraid network graph like ZimaOS: waiting on what this Unraid version exposes. Press Test on the Unraid connection and note the "Network-related fields" line.

- ZimaOS Storage: ZimaOS's own widget shows health, used and total for the storage pool; Homebase lists drives only.
- UniFi UNAS: connection signs in with a local account (as Homepage does) and tries likely /proxy/drive addresses; confirm against a real UNAS with the connection Test result and adjust.
- ZimaOS containers/VMs: confirm which endpoints your system answers (connection Test lists what is readable).
- Verify against real hardware: Protect, Prowlarr, Site Gateway, Unraid, ZimaOS.

## Done
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
