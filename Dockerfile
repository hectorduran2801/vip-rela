# VIP: tres imágenes (web, api, worker) a partir de una sola compilación.
FROM node:24-bookworm-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH COREPACK_ENABLE_DOWNLOAD_PROMPT=0
# Chrome lo instala la imagen del worker; que ninguna dependencia lo descargue.
ENV PUPPETEER_SKIP_DOWNLOAD=true PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
RUN corepack enable
WORKDIR /app

FROM base AS build
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY services/whatsapp-worker/package.json services/whatsapp-worker/
COPY packages/shared/package.json packages/shared/
COPY packages/excel-import/package.json packages/excel-import/
COPY packages/excel-export/package.json packages/excel-export/
COPY packages/db/package.json packages/db/
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm --filter @vip/shared build \
 && pnpm --filter @vip/excel-import --filter @vip/excel-export build \
 && pnpm --filter @vip/api --filter @vip/whatsapp-worker build \
 && pnpm --filter @vip/web build

FROM nginx:1.29-alpine AS web
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/web/dist/web/browser /usr/share/nginx/html

FROM base AS api
ENV NODE_ENV=production
COPY --from=build /app /app
WORKDIR /app/apps/api
USER node
CMD ["node", "dist/server.js"]

FROM base AS worker
RUN apt-get update && apt-get install -y --no-install-recommends chromium fonts-liberation fonts-noto-color-emoji ca-certificates zstd \
 && rm -rf /var/lib/apt/lists/*
# Dentro del contenedor Chrome no puede crear su propio aislamiento: se arranca con --no-sandbox (el aislamiento lo da el
# contenedor, que además corre sin privilegios). Solo abre WhatsApp Web.
RUN printf '#!/bin/sh\nexec /usr/bin/chromium --no-sandbox "$@"\n' > /usr/local/bin/chromium-vip && chmod 755 /usr/local/bin/chromium-vip
ENV NODE_ENV=production CHROME_PATH=/usr/local/bin/chromium-vip
COPY --from=build /app /app
# La sesión de WhatsApp vive en un volumen: sobrevive a reinicios y actualizaciones.
RUN mkdir -p /data/openwa && chown -R node:node /data
WORKDIR /app/services/whatsapp-worker
USER node
CMD ["node", "dist/main.js"]
