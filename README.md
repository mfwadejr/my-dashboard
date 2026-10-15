# Homebase

A self-hosted dashboard with tabs, groups, resizable tiles, live app stats and camera feeds. One container plus go2rtc, one compose file.

## Install on ZimaOS

1. Open the ZimaOS App Store, click **+** (Custom Install) and import `deploy/compose.zimaos.yaml`.
2. Open `http://<your-zima-ip>:3000`. Anyone on your network can view the dashboard.
3. Click **Set up**, choose an admin password, then **Edit**. The password is only needed to change things.
4. **Connections** → pick Sonarr, Radarr or SABnzbd → enter the address and API key → **Test connection** → Save.
5. **Add tile** in a group, choose the connection, and drag/resize tiles. Layout is saved automatically.

To update, pull the newest image (`ghcr.io/mfwadejr/my-dashboard:latest`) and recreate the container. Your data lives in `/DATA/AppData/homebase/data`.

> The first image build creates a GitHub package that is private by default. Open
> github.com/mfwadejr → Packages → my-dashboard → Package settings → set visibility to **Public**, otherwise ZimaOS cannot pull it.

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

Built from the Homarr/app API behaviour and tested against mocks only. Please use **Test connection** on your real Sonarr, Radarr and SABnzbd, and check the go2rtc camera stream endpoints with a real camera. Report anything that looks off.

## Roadmap

Prowlarr, Plex, Jellyfin, Seerr; then UniFi, Unraid, ZimaOS system stats.
