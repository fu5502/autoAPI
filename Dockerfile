FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build
RUN pnpm deploy --legacy --filter @autoapi/api --prod /prod/api

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV CHROME_BIN=/usr/bin/chromium
ENV TZ=Asia/Shanghai
RUN apt-get update \
  && apt-get install -y --no-install-recommends chromium xvfb x11vnc fluxbox novnc websockify fonts-noto-cjk fonts-liberation ca-certificates wget tzdata \
  && rm -rf /var/lib/apt/lists/* \
  && ln -sf /usr/share/novnc/vnc.html /usr/share/novnc/index.html
COPY --from=build /prod/api/node_modules ./node_modules
COPY --from=build /prod/api/package.json ./package.json
COPY --from=build /app/apps/api/dist ./apps/api/dist
COPY --from=build /app/apps/api/migrations ./apps/api/migrations
COPY --from=build /app/apps/web/dist ./apps/web/dist
COPY docker/start-container.sh /usr/local/bin/start-autoapi-container
COPY docker/start-novnc.sh /usr/local/bin/start-novnc
COPY docker/start-checkin-display.sh /usr/local/bin/start-checkin-display
RUN chmod +x /usr/local/bin/start-autoapi-container /usr/local/bin/start-novnc /usr/local/bin/start-checkin-display \
  && mkdir -p /data/checkin/browser-profile \
  && chown -R node:node /data
USER node
EXPOSE 8080
VOLUME ["/data/checkin"]
CMD ["start-autoapi-container"]
