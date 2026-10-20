# syntax=docker/dockerfile:1
FROM node:24-alpine AS build
ARG APP_COMMIT=dev
ARG APP_BUILT=
ENV APP_COMMIT=$APP_COMMIT APP_BUILT=$APP_BUILT
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.server.json ./
COPY server/src server/src
COPY web web
RUN npm run build

FROM node:24-alpine
ARG APP_COMMIT=dev
ARG APP_BUILT=
ENV NODE_ENV=production DATA_DIR=/data PORT=3000 PUBLIC_PORT=3001 HOST=0.0.0.0 WEB_DIR=/app/dist/web APP_COMMIT=$APP_COMMIT APP_BUILT=$APP_BUILT
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist dist
# smbclient lets Homebase copy backups to an SMB/Windows share (SMB 3 signing and encryption included)
RUN apk add --no-cache samba-client iputils-ping && mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 3000 3001
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD wget -q -O /dev/null http://127.0.0.1:3000/api/health || exit 1
CMD ["node", "--disable-warning=ExperimentalWarning", "dist/server/index.js"]
