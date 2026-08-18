FROM node:22-alpine AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable && corepack prepare pnpm@11.22.0 --activate
WORKDIR /app

FROM base AS builder
COPY package.json pnpm-lock.yaml tsconfig.json ./
COPY pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY src ./src
COPY scripts ./scripts
COPY migrations ./migrations
RUN pnpm run build

FROM base AS runner
COPY package.json pnpm-lock.yaml ./
COPY pnpm-workspace.yaml ./
RUN pnpm install --prod --frozen-lockfile
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/migrations ./migrations
EXPOSE 3000
CMD ["sh", "-c", "node dist/scripts/migrate.js && node dist/src/index.js"]
