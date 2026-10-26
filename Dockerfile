# syntax=docker/dockerfile:1.7
# One multi-target build for every YeaStay service. All bases are multi-arch,
# so this builds natively on the ARM64 EC2 t4g.large (and on amd64 CI).
#   docker build --target api .        (also: worker, sl-mock, backoffice, pwa)

ARG NODE_IMAGE=node:22-alpine
ARG CADDY_IMAGE=caddy:2.10-alpine

FROM ${NODE_IMAGE} AS deps
WORKDIR /repo
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
COPY apps/backoffice/package.json apps/backoffice/
COPY apps/pwa/package.json apps/pwa/
COPY apps/sap-worker/package.json apps/sap-worker/
COPY apps/sap-sl-mock/package.json apps/sap-sl-mock/
RUN npm ci --no-audit --no-fund

FROM deps AS build
COPY tsconfig.base.json ./
COPY packages packages
COPY apps apps
RUN npm run build -w @hotel/shared \
 && npm run build -w @hotel/api -w @hotel/sap-sl-mock -w @hotel/sap-worker -w @hotel/backoffice -w @hotel/pwa

FROM deps AS prod-deps
RUN npm ci --omit=dev --no-audit --no-fund

FROM ${NODE_IMAGE} AS node-runtime
ENV NODE_ENV=production
WORKDIR /repo
COPY --from=prod-deps /repo/node_modules node_modules
COPY --from=build /repo/package.json ./
COPY --from=build /repo/packages/shared/package.json packages/shared/
COPY --from=build /repo/packages/shared/dist packages/shared/dist
USER node

FROM node-runtime AS api
COPY --from=build /repo/apps/api/package.json apps/api/
COPY --from=build /repo/apps/api/dist apps/api/dist
COPY --from=build /repo/apps/api/migrations apps/api/migrations
WORKDIR /repo/apps/api
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=3s --retries=5 CMD wget -qO- http://127.0.0.1:3000/api/health >/dev/null || exit 1
CMD ["node", "--enable-source-maps", "dist/main.js"]

FROM node-runtime AS worker
COPY --from=build /repo/apps/sap-worker/package.json apps/sap-worker/
COPY --from=build /repo/apps/sap-worker/dist apps/sap-worker/dist
WORKDIR /repo/apps/sap-worker
CMD ["node", "--enable-source-maps", "dist/index.js"]

FROM node-runtime AS sl-mock
COPY --from=build /repo/apps/sap-sl-mock/package.json apps/sap-sl-mock/
COPY --from=build /repo/apps/sap-sl-mock/dist apps/sap-sl-mock/dist
WORKDIR /repo/apps/sap-sl-mock
EXPOSE 50000
HEALTHCHECK --interval=15s --timeout=3s CMD wget -qO- http://127.0.0.1:50000/mock/health >/dev/null || exit 1
CMD ["node", "dist/main.js"]

FROM ${CADDY_IMAGE} AS backoffice
COPY deploy/caddy/static.Caddyfile /etc/caddy/Caddyfile
COPY --from=build /repo/apps/backoffice/dist /srv

FROM ${CADDY_IMAGE} AS pwa
COPY deploy/caddy/static.Caddyfile /etc/caddy/Caddyfile
COPY --from=build /repo/apps/pwa/dist /srv
