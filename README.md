# Homebase

A self-hosted dashboard with tabs, groups, resizable tiles, live app stats and camera feeds. One container plus go2rtc, one compose file.

## Install on ZimaOS

1. Open the ZimaOS App Store, click **+** (Custom Install) and import `deploy/compose.zimaos.yaml`.
2. Open `http://<your-zima-ip>:3000`. Anyone on your network can view the dashboard.
3. Click **Set up**, choose an admin password, then **Edit**. The password is only needed to change things.
4. **Connections** → pick an app (Sonarr, Radarr, Prowlarr, SABnzbd, Site Gateway, UniFi Network/Protect/PDU) → enter the address and API key → **Test connection** → Save.
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
| UniFi Network, Protect, PDU | the console, e.g. `https://192.168.1.1` | an API key created inside that UniFi application (Integrations) |

UniFi consoles use a self-signed certificate: tick **Allow a self-signed certificate** on those connections. The **UniFi PDU** connection finds PDUs among your UniFi Network devices; per-outlet power uses UniFi's classic API when your console allows it. **UniFi probe (UNAS / PDU)** has no tile: press Test connection and it lists which API addresses your console answers (key names only, never values), which is how UNAS support will be built.

## Cameras

Add a camera tile, then **Add a camera** with its RTSP address (main stream, optional lighter sub-stream for the grid). Homebase registers the streams with go2rtc, which converts them for the browser. Passwords are stored encrypted and are never sent to viewers. Click a camera tile to open it full size.

## Security notes

- Viewing is open on your LAN; every change needs the admin password (session cookie, 30 days).
- API keys and camera URLs are encrypted at rest (AES-256-GCM). The key is generated into the data folder, or set `HOMEBASE_SECRET_KEY`. Back up both.
- go2rtc's own web UI has no login. Do not expose port 1984 or Homebase to the internet without a reverse proxy that adds authentication.

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

Plex, Jellyfin, Seerr; UniFi UNAS (needs the probe output from real hardware); Unraid and ZimaOS system stats; PDU outlet switching; feeding UniFi Protect cameras into the camera wall.
