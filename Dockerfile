FROM node:20-alpine
# tini as PID 1 so SIGTERM/SIGINT from `docker stop` (and orchestrators)
# reach node through a proper reaping init instead of being dropped --
# required for the graceful-shutdown handler in server.js to ever run.
RUN apk add --no-cache tini
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY server.js metrics-store.js gemini-cache.js README.md ./
COPY public ./public
COPY api ./api
ENV NODE_ENV=production PORT=8787
EXPOSE 8787
USER node
# fail-fast on unhandled rejections (server.js installs an exit hook; see
# the graceful-shutdown section there). Node 20's default is already "throw";
# this pins the behavior explicitly against future default changes.
ENV NODE_OPTIONS=--unhandled-rejections=strict
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "server.js"]
