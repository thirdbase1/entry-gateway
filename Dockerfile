FROM node:20-alpine
# tini as PID 1 so SIGTERM/SIGINT from `docker stop` (and orchestrators)
# reach node through a proper reaping init instead of being dropped --
# required for the graceful-shutdown handler in server.js to ever run.
RUN apk add --no-cache tini
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY server.js metrics-store.js gemini-cache.js config-validation.js upstream-abort.js README.md ./
COPY public ./public
COPY api ./api
ENV NODE_ENV=production PORT=8787
EXPOSE 8787
USER node
# HEALTHCHECK hits the liveness probe, not /health: /health does live Postgres
# reads, and a container whose metrics DB is slow must not be reported dead
# while it is still serving proxied traffic. Alpine's node image ships no
# curl/wget, so use node itself rather than adding a package to the attack
# surface of a production image.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/health/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
# fail-fast on unhandled rejections (server.js installs an exit hook; see
# the graceful-shutdown section there). Node 20's default is already "throw";
# this pins the behavior explicitly against future default changes.
ENV NODE_OPTIONS=--unhandled-rejections=strict
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "server.js"]
