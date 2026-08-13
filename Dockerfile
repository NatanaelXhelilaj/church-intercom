# syntax=docker/dockerfile:1

# ---------------------------------------------------------------- build stage
# mediasoup compiles a C++ worker binary and bcrypt has a native addon, so the
# toolchain is needed here. None of it ships in the runtime image.
FROM node:22-bookworm-slim AS builder

RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 \
      make \
      g++ \
      ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

# Bundle mediasoup-client into a self-contained browser file. The published
# package is CommonJS with bare specifiers, so a browser cannot import it
# directly — without this step the client silently falls back to a public CDN,
# which is fatal on a church LAN with no internet access.
COPY . .
RUN npm run build:vendor \
    && npm prune --omit=dev

# -------------------------------------------------------------- runtime stage
FROM node:22-bookworm-slim AS runtime

# ffmpeg does all audio work (capture, Opus encode, RTP, ALSA playback).
# alsa-utils is included so `docker compose exec app arecord -l` can identify
# the sound card without installing anything on the host.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg \
      alsa-utils \
      ca-certificates \
      tini \
    && rm -rf /var/lib/apt/lists/*

# Run unprivileged. Group `audio` owns /dev/snd/*; without membership the
# container cannot open the USB interface.
RUN usermod -aG audio node

WORKDIR /app

COPY --from=builder --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/public ./public
COPY --chown=node:node package.json server.js config.js audio.js auth.js db.js healthcheck.js ./
COPY --chown=node:node database.sql ./

USER node

ENV NODE_ENV=production

# tini reaps the ffmpeg children. Without an init, a killed ffmpeg becomes a
# zombie held by PID 1, and enough restarts exhaust the process table.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "server.js"]
