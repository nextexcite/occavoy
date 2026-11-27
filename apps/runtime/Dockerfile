# Build from repository root: docker build -f apps/runtime/Dockerfile .
FROM node:26.13.1-bookworm-slim AS build
RUN npm install --global pnpm@12.23.0
WORKDIR /workspace
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/runtime/package.json apps/runtime/package.json
RUN pnpm install --frozen-lockfile --filter occavoy --filter @occavoy/runtime
COPY apps/runtime/ apps/runtime/
RUN pnpm --filter @occavoy/runtime build
RUN pnpm --filter @occavoy/runtime --prod deploy /runtime

FROM node:26.13.1-bookworm-slim AS runtime
ENV NODE_ENV=production
ENV OCCAVOY_RUNTIME_MODE=cloud
ENV PORT=8080
WORKDIR /app
COPY --from=build --chown=node:node /runtime/ ./
USER node
EXPOSE 8080
CMD ["node", "dist/server.js"]
