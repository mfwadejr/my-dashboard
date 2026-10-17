# Fix list

Small fixes and follow-ups, newest first. Move an item to Done when it ships.

## Open

- ZimaOS Storage: ZimaOS's own widget shows health, used and total for the storage pool; Homebase lists drives only.
- UniFi UNAS: connection signs in with a local account (as Homepage does) and tries likely /proxy/drive addresses; confirm against a real UNAS with the connection Test result and adjust.
- ZimaOS containers/VMs: confirm which endpoints your system answers (connection Test lists what is readable).
- Verify against real hardware: Protect, Prowlarr, Site Gateway, Unraid, ZimaOS.

## Done

- SABnzbd tile: section picker (summary, speed graph, queue, download disk, speed limit, history); status and warnings pills; pause/resume/remove per job; retry failed history; speed limit control; today/week totals.
- UniFi UNAS connection and tile (storage used/free gauge) built; unverified on real hardware.
- ZimaOS tile: live Network graph like ZimaOS's own (2-second samples, grid, smooth filled curves). Sampling runs only while a browser has the tile open.
- ZimaOS tile: CPU and RAM shown as arc gauges like ZimaOS's own System widget (CPU shows power and temperature, RAM shows used of total); unlabeled memory bar removed.
- ZimaOS tile: choose and order sections; app list, containers and VMs (container/VM endpoints are best-effort until checked on a real system).
- UniFi Network tile: choose and order sections (summary, gateway, WAN links with per-WAN rates, speed test, access points, Wi-Fi, VLANs, all devices, offline devices).
- PDU: USB outlets show "Not metered by this PDU" on hover (they report `outlet_caps=1`, no power data).
- PDU: watts, voltage, current, outlet icons colored by state and load.
