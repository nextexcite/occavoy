# Build from repository root: docker build -f apps/runtime/Dockerfile .
FROM node:26.13.1-bookworm-slim AS build
RUN npm install --global pnpm@12.23.0
WORKDIR /workspace
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/runtime/package.json apps/runtime/package.json
COPY packages/domain/package.json packages/domain/package.json
COPY packages/storage/package.json packages/storage/package.json
RUN pnpm install --frozen-lockfile --filter occavoy --filter @occavoy/runtime
COPY apps/runtime/ apps/runtime/
COPY packages/domain/ packages/domain/
COPY packages/storage/ packages/storage/
RUN pnpm --filter @occavoy/runtime build
RUN pnpm --filter @occavoy/runtime --prod deploy /runtime
RUN rm -rf \
  /runtime/node_modules/.pnpm/@rivet-dev+agentos-* \
  /runtime/node_modules/.pnpm/@rivet-dev+agent-os-* \
  /runtime/node_modules/.pnpm/@agentos-software+* \
  /runtime/node_modules/.pnpm/@rivet-dev+services@* \
  /runtime/node_modules/.pnpm/@rivet-dev+services-*@* \
  /runtime/node_modules/.pnpm/@rivetkit+engine-cli@* \
  /runtime/node_modules/.pnpm/@rivetkit+engine-cli-*@* \
  /runtime/node_modules/.pnpm/rivetkit@*/node_modules/@rivet-dev/services \
  /runtime/node_modules/.pnpm/rivetkit@*/node_modules/@rivetkit/engine-cli

FROM node:26.13.1-bookworm-slim AS runtime
ENV NODE_ENV=production
ENV OCCAVOY_RUNTIME_MODE=cloud
ENV PORT=8080
WORKDIR /app
COPY --from=build --chown=node:node /runtime/ ./
USER node
EXPOSE 8080
CMD ["node", "dist/server.js"]
