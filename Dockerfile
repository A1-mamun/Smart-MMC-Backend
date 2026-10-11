# syntax=docker/dockerfile:1.7

# ─── deps stage ─────────────────────────────────────────────────────────────
# Installs ALL deps (incl. devDependencies) so we can compile TypeScript
# and run prisma generate. Uses pnpm via corepack so we don't need to
# install pnpm globally on the image.
FROM node:22-alpine AS deps
RUN corepack enable
WORKDIR /app

# Copy the lockfile + package manifest + the Prisma schema (prisma
# generate is wired as a postinstall hook and needs the schema
# available even before the rest of the source is copied).
COPY package.json pnpm-lock.yaml ./
COPY prisma ./prisma

# `--frozen-lockfile` keeps CI builds deterministic. `--ignore-scripts`
# skips the postinstall `prisma generate` here — we'll run it for real
# in the build stage once the schema is in place.
RUN pnpm install --frozen-lockfile --ignore-scripts

# ─── build stage ────────────────────────────────────────────────────────────
# Compiles TypeScript → dist/ and runs `prisma generate` to emit the
# typed client into node_modules/.prisma (needed by the runner stage).
# We inherit from `deps` (which installed with `--ignore-scripts` to keep
# the deps layer cacheable), but we MUST run `prisma generate` here
# before `tsc` — otherwise the source code referencing `Prisma`,
# `PrismaClient`, enum members etc. from `@prisma/client` fails to
# type-check. We invoke it explicitly (rather than relying on the
# `postinstall` hook) because pnpm does NOT re-run lifecycle scripts
# when the lockfile is already satisfied — it sees the cached
# `node_modules` from the `deps` stage and skips them.
FROM deps AS build
COPY tsconfig.json ./
COPY src ./src

# Explicit `prisma generate` — must run BEFORE `tsc` so the typed
# client exists in node_modules/.prisma/client and @prisma/client can
# re-export the generated `Prisma` / `PrismaClient` / enum members.
RUN npx prisma generate
# Run the TypeScript compiler directly instead of `pnpm run build`
# because the project's `build` script has a `postbuild` hook
# (`prisma migrate deploy`) that needs a live DATABASE_URL. There's
# no Postgres in the image-build context — migrations are applied
# instead at container start (see the `CMD` in the runner stage).
RUN pnpm exec tsc

# ─── runner stage ───────────────────────────────────────────────────────────
# Slim production image. Only prod deps, no TypeScript, no dev tooling.
FROM node:22-alpine AS runner
RUN corepack enable
WORKDIR /app
ENV NODE_ENV=production

# We need the Prisma CLI at runtime to run `migrate deploy` on every
# container start, so we install ALL dependencies here (the Prisma CLI
# is a devDependency that doesn't ship in a `--prod` install). The
# `--ignore-scripts` flag skips the `postinstall` `prisma generate`
# hook in pnpm's lifecycle because pnpm does NOT re-run lifecycle
# scripts on a satisfied lockfile — but we run `prisma generate`
# ourselves right after, in this same stage, so the runtime client is
# placed inside the pnpm virtual store at the path
# `node_modules/.pnpm/@prisma+client@*/node_modules/.prisma/client`
# that the `@prisma/client` runtime resolves at import time.
COPY package.json pnpm-lock.yaml ./
COPY prisma ./prisma
RUN pnpm install --frozen-lockfile --ignore-scripts
RUN npx prisma generate

# Compiled JS from the build stage.
COPY --from=build /app/dist ./dist

EXPOSE 5002

# Apply any pending migrations (idempotent — safe to re-run on every
# container start) and boot the server. Migrations are NOT run during
# `docker build` because there's no Postgres in the build context;
# they run here, after `depends_on` confirms Postgres is healthy.
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/server.js"]
