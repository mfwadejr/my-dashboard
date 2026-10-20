# Homebase

A self-hosted dashboard with tabs, groups, resizable tiles, live app stats and camera feeds. One container plus go2rtc, one compose file.

## Install on ZimaOS

1. Open the ZimaOS App Store, click **+** (Custom Install) and import `deploy/compose.zimaos.yaml`.
2. Open `http://<your-zima-ip>:3000`. The first visit asks you to create the admin account (nobody sees anything without signing in).
3. Press **/** (or Ctrl/Cmd+K) to search everything: tabs, tiles, Launcher links, connections, cameras and settings pages. Connections can have an optional *open address* (what your browser uses) and can open inside Homebase when the app allows being shown in a frame; otherwise they open in a new tab.
3. Click **Edit** to change the layout. The ⚙ gear opens Settings: backups, people, sharing, status and the log.
4. **Connections** → pick an app (Sonarr, Radarr, Prowlarr, SABnzbd, Site Gateway, Unraid, ZimaOS, UniFi Network/Protect/PDU/UNAS) → enter the address and API key → **Test connection** → Save.
5. **Add tile** in a group, choose the connection, and drag/resize tiles. Layout is saved automatically.

To update, pull the newest image (`ghcr.io/mfwadejr/my-dashboard:latest`) and recreate the container. Your data lives in `/DATA/AppData/homebase/data`.

> The first image build creates a GitHub package that is private by default. Open
> github.com/mfwadejr → Packages → my-dashboard → Package settings → set visibility to **Public**, otherwise ZimaOS cannot pull it.

## Connections

| App | Address | Key |
|---|---|---|
| Sonarr, Radarr, Prowlarr | the app's address | API key (Settings → General) |
| SABnzbd | the app's address | API key |
| Site Gateway | its dashboard address, e.g. `http://host:8080` | an API token (read-only is enough) |
| UniFi UNAS | the UNAS address, for example `https://192.168.1.50` (tick the self-signed box) | a local, read-only UniFi account as `username:password` (the API key interface does not cover the UNAS). Unverified on real hardware: run Test and check which addresses answer |
| Unraid | `http://tower` (use `https://` if your server uses SSL, and tick the self-signed box) | an API key from Settings → Management Access → API Keys (Unraid 7.2+) |
| ZimaOS | `http://zima-ip` | your ZimaOS login as `username:password` (ZimaOS has no API keys; stored encrypted; a dedicated user is best) |
| UniFi Network, Protect, PDU | the console, e.g. `https://192.168.1.1` | an API key created inside that UniFi application (Integrations) |

On a **UniFi Network** connection, **Load the console's fields** (after entering the address and key) lists every value the console reports, so you can pick what the tile's **Custom stats** section shows; **WAN links** shows live per-link rates, active/standby, latency and availability.

UniFi consoles use a self-signed certificate: tick **Allow a self-signed certificate** on those connections. The **UniFi PDU** connection finds PDUs among your UniFi Network devices; per-outlet power uses UniFi's classic API when your console allows it. **UniFi probe (UNAS / PDU)** has no tile: press Test connection and it lists which API addresses your console answers (key names only, never values), which is how UNAS support will be built.

## Cameras

Add a camera tile, then **Add a camera** with its RTSP address (main stream, optional lighter sub-stream for the grid). Homebase registers the streams with go2rtc, which converts them for the browser. Passwords are stored encrypted and are never sent to viewers. Click a camera tile to open it full size. **Test** in the camera dialog connects and shows a picture before you save. If you have a UniFi Protect connection, **Find cameras** imports them with their stream addresses. A camera can be shown as live video or as a snapshot refreshed every 5 to 60 seconds, and the **Camera wall** tile shows several cameras at once (snapshots by default; pictures need ffmpeg in go2rtc, which the standard image includes).

## Security notes

- Nothing is visible without signing in (or a valid share link). Accounts are **Admin** (everything) or **Viewer** (look, don't change). Sessions last 30 days, can be listed and ended under Settings → Access, and the login limit survives restarts.
- API keys and camera URLs are encrypted at rest (AES-256-GCM). The key is generated into the data folder as `secret.key`, or set `HOMEBASE_SECRET_KEY`. Download it from Settings → Data & backup and keep it apart from your backups.
- go2rtc's own web UI has no login. Never expose port 1984.
- Keep port 3000 (the dashboard) off the internet. To share cameras, see **Sharing from outside** below.

## Settings

The ⚙ gear (admins) opens:

- **General**: dashboard name, time zone, 12/24-hour clock, week start, public address, theme and accent (a dashboard default plus a per-device choice), and wall display.
- **Data & backup**: download a Complete backup (database plus saved icons in one `.tar.gz`), or a backup file (passwords and keys, and optionally accounts, only with a passphrase), restore it with a preview (replace or merge), and check any `.db` or `.json` file with **Verify a file**. Database copies are saved on a schedule (every 6 hours, daily or weekly), each one is checked right away, and any copy can be verified or **restored** from the page (or pick a file with **Restore from a file…**) (a safety copy of the current state is saved first, then Homebase restarts, so keep `restart: unless-stopped`). Copies can also be sent to a NAS over SFTP or SMB from inside Homebase; use a dedicated NAS account limited to one folder. Before an upgrade that changes the database layout a safety copy is saved automatically, and Homebase refuses to start on a database written by a newer version. SQLite stays the live database; the JSON file is only for moving and restoring. The same page sets how long **graph history** is kept in three tiers (full detail, hourly averages, daily averages), the **log rules** (by severity, by area and by size, with an optional CSV of removed lines and a preview before anything is removed) and **database upkeep** (integrity check, vacuum, weekly by default). The Status page warns when the disk is getting full, and the container health check also tests that the database is writable.
- **Access**: people, roles, your password, **two-factor sign-in** (a six-digit code from an authenticator app after the password, with one-time recovery codes; an admin can reset someone who lost both, or run the container once with `HOMEBASE_RESET_2FA=<username>`), an optional **idle sign-out** for admins (wall displays stay signed in), and signed-in devices.
- **Icons**: pick how much of the Dashboard Icons, selfh.st and Lucide libraries to keep (search only, search with cache, or a local mirror in one or every format). Nothing is downloaded until you choose. Icons you use are saved as their own copies in the data folder (`icons/used/`) and never change by themselves; a list shows when a library has a newer picture and you update with one click. The picker appears wherever an icon is used.
- **API access**: named tokens other tools use as `Authorization: Bearer hb_...`. Read-only or read-write, shown once, revocable, every use logged. Tokens can never manage people, backups, sharing or other tokens. `GET /api/summary` returns a flat list of connection states for Home Assistant and similar.
- **Sharing**: links for one or many cameras (name, expiry, optional PIN, switch off any time) and wall-display links.
- **Status & log**: each connection's state, speed and 24-hour history; a searchable log written in plain sentences ("Sonarr "Main" is unreachable: timed out after 10s") with filters and CSV export.
- **About**: version, build, start time, and an optional once-a-day check against GitHub for newer changes (off by default, because, apart from the icon library refresh once you have chosen a storage option, it is the only thing that contacts the outside by itself). The version is also in the page footer, so you can see an update took effect.

## Sharing from outside

Homebase listens on two ports. **3000** is the dashboard. **3001** (`PUBLIC_PORT`, `0` turns it off) answers only share links and the video for the cameras in them: no dashboard, no sign-in, no settings. Point your reverse proxy (HTTPS) at 3001 only, forward `X-Forwarded-For`, and set `TRUST_PROXY=true`. Then set the public address in Settings → General so copied links point there. Wall-display links never work on 3001; open them on your home network. Add `- "3001:3001"` under `ports` if you want to reach the sharing port directly.

## Wall display

Open the dashboard with `?kiosk=1`, tick **Use wall display mode here** in Settings → General, or create a wall-display link (no password, read-only, home network only). It hides the header and editing, keeps the screen awake, reloads after an update, and can cycle through tabs. In a browser, "Add to home screen" installs it full-screen.

## Development

```
npm ci
npm test            # server tests against mock Sonarr/Radarr/SABnzbd/go2rtc
npm run build
npx tsx server/dev/demo.ts   # full app with fake apps on http://127.0.0.1:3100
```

Add an app: write one file in `server/src/integrations/` exporting an `IntegrationType`, list it in `registry.ts`, then add a tile component in `web/src/widgets/`.

## Not yet verified against real servers

Built from the Homarr/app API behaviour and tested against mocks only. UniFi's response field names are only partly published, so the UniFi tiles read them defensively and may show "–" for anything your firmware names differently. Please use **Test connection** on your real apps, and check the go2rtc camera stream endpoints with a real camera. Report anything that looks off.

## Roadmap

Plex, Jellyfin, Seerr; UniFi UNAS drive details (needs the Test output from real hardware); Unraid container start/stop; PDU outlet switching; feeding UniFi Protect cameras into the camera wall.

## Media calendar

Add the "Media calendar" tile, tick your Sonarr and Radarr connections, and choose which Radarr release date to show (digital, cinema, physical or all). Filled dots mean downloaded; click a day for details. Posters are fetched through Homebase, so your app addresses and keys never reach the browser.

## Moving tiles

In edit mode, drag any tile and drop it where you want; it snaps to the grid and a dashed outline shows where it will land. Tiles in the way move down to make room. You can drag a tile into another group, press Esc to cancel, and drag the corner to resize. Each group has an **Auto-pack** switch: off keeps tiles exactly where you drop them (gaps allowed), on lets them float up to fill empty space. The arrange presets (2 per row and so on) are one-time buttons for camera tiles. Moving a tile yourself switches the group back to Free. On a phone the tiles stack in reading order.

## Monitoring and status pages

**Settings → Monitors** keeps watch on websites, ports and DNS names from the machine Homebase runs on, the way Uptime Kuma does. Each monitor is checked every 20 seconds or slower (default 60), a failed check is repeated before the monitor is shown as down, and the page shows response time, uptime for a day, week and month, and when an https certificate ends (with a log warning before it does). Down and back-up changes are written to the log. Kinds: **Website** (status codes that count as up, GET or HEAD, redirects followed), **Website with a word on the page** (present or absent), **Port** (is something listening) and **DNS** (record type, optional DNS server, optional text the answer must contain). A **Monitors** tile shows all or chosen monitors on the dashboard. History is kept as detailed checks for 8 days and daily totals for 400 days.

**Monitoring** has its own tab at the top of the dashboard. Monitors can be put in groups (all your Arrs, several Plex servers, the services that make up one app); a group shows how many of its monitors are up and can be paused or resumed as a whole. Check types: website (any HTTP method, request body, custom headers, basic auth, redirect limit, status code ranges), website with a word on the page, website answer (a JSON field must exist or equal a value), port, ping, DNS name, certificate expiry, and heartbeat (a script or cron job calls `/api/push/<code>` and the monitor goes down when calls stop). Each monitor has its own retry interval, an upside-down mode, a description, and a detail view with a response-time chart (6 hours to 90 days), uptime for 24 hours, 7, 30, 90 days and a year, state changes and the latest checks. Maintenance windows (once, daily or on chosen days, in the time zone from General settings) pause checks and show "Maintenance" instead of "Down". Request headers and passwords are stored encrypted and are left out of JSON backups, which say which monitors need them entered again.

**Status pages** are public read-only pages for chosen monitors, grouped the way the monitors are, with a title, a message (information, warning or problem style) and 45-day uptime bars. They never show addresses or error details. The link opens on the sharing port (3001) like camera links, can be switched off, and can be replaced with a new link (the old one stops working). Monitors and status pages are included in the JSON backup file; check history is not. Ping needs the `ping` program (added to the image) and the container's default network capability; if your host strips it, use a Port check. Not built yet: outside alerts (ntfy, Discord, webhooks), MQTT and Steam check types, and Prometheus metrics.

**Docker, databases and group monitors.** A Docker monitor asks the Docker engine whether a named container is running (and healthy, when it has a health check). It needs the Docker socket mounted into the Homebase container (a commented line in the compose files shows how), which hands that container control of Docker on the host, so it is off by default. Database monitors (PostgreSQL, MySQL/MariaDB, MongoDB, Redis, SQL Server) connect with a connection string, run a harmless query (SELECT 1, a ping, PING) and time it. The connection string holds the password, so it is stored encrypted, never sent back to the browser, hidden in error messages, left out of JSON backups (the import lists which monitors need it again), and its query runs as that account, so give it a read-only one. A group monitor has no check of its own: put other monitors (or other group monitors) inside it and it is down when any of them is down. Paused monitors and monitors in maintenance do not count. Removing a group frees what was inside it.

**More on status pages.** Give a page its own domain (point the name at the sharing port in your reverse proxy, with HTTPS there) and that domain shows the page at its front. Posts are pinned announcements with a title, details and a style (information, warning, outage, good news) that you edit as things change and mark resolved; resolved posts stay for 14 days. Planned maintenance windows that cover the page's monitors are listed on it, and a window that is happening now is marked. Each page has an SVG badge (whole page, or any monitor: status, uptime or response time) and an RSS feed of its posts, with the addresses under "Badges & RSS".
