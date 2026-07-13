# festival_recap — production image
# bookworm-slim (glibc) so native deps (sharp prebuilds) install cleanly on ARM64 (Pi).
FROM node:20-bookworm-slim

ENV NODE_ENV=production
WORKDIR /app

# ffmpeg (Debian bookworm ships 5.1.x — includes xfade, zoompan, blurdetect,
# signalstats natively, no special build flags needed) + python3-opencv for
# the lightweight face/crowd-count helper (scripts/face_count.py). Using the
# apt package (not pip) avoids building opencv from source on ARM64.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg python3 python3-opencv fonts-dejavu-core \
 && rm -rf /var/lib/apt/lists/*

# Install deps first for layer caching. Only production deps.
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

# App source
COPY src ./src
COPY scripts ./scripts
COPY public ./public
COPY music ./music

# Runtime data dir (mounted as a volume in compose; created for local runs too).
RUN mkdir -p /app/data/uploads /app/data/renders /app/data/tmp \
    && chown -R node:node /app/data

# Run as the unprivileged built-in `node` user (uid 1000).
USER node

EXPOSE 3000
CMD ["node", "src/server.js"]
