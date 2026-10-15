# Fix list

Small fixes and follow-ups, newest first. Move an item to Done when it ships.

## Open

- UniFi UNAS tile: no documented API; Drive/Access probe paths did not return JSON.
- ZimaOS containers/VMs: confirm which endpoints your system answers (connection Test lists what is readable).
- Verify against real hardware: Protect, Prowlarr, Site Gateway, Unraid, ZimaOS.

## Done

- ZimaOS tile: CPU and RAM shown as arc gauges like ZimaOS's own System widget (CPU shows power and temperature, RAM shows used of total); unlabeled memory bar removed.
- ZimaOS tile: choose and order sections; app list, containers and VMs (container/VM endpoints are best-effort until checked on a real system).
- UniFi Network tile: choose and order sections (summary, gateway, WAN links with per-WAN rates, speed test, access points, Wi-Fi, VLANs, all devices, offline devices).
- PDU: USB outlets show "Not metered by this PDU" on hover (they report `outlet_caps=1`, no power data).
- PDU: watts, voltage, current, outlet icons colored by state and load.
