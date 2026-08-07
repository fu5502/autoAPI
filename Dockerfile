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
ENV DISPLAY=:99
ENV XDG_RUNTIME_DIR=/tmp/autoapi-runtime
ENV TZ=Asia/Shanghai
RUN apt-get update \
  && apt-get install -y --no-install-recommends chromium xvfb x11-utils x11vnc fluxbox novnc websockify fonts-noto-cjk fonts-liberation ca-certificates wget tzdata \
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
COPY docker/wait-for-display.sh /usr/local/bin/wait-for-display
RUN chmod +x /usr/local/bin/start-autoapi-container /usr/local/bin/start-novnc /usr/local/bin/start-checkin-display /usr/local/bin/wait-for-display \
  && mkdir -p /data/checkin/browser-profile /tmp/autoapi-runtime \
  && chmod 700 /tmp/autoapi-runtime \
  && chown -R node:node /data \
  && chown node:node /tmp/autoapi-runtime
USER node
EXPOSE 8080
VOLUME ["/data/checkin"]
CMD ["start-autoapi-container"]
