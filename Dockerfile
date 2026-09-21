# syntax=docker/dockerfile:1

# ─────────────────────────────────────────────────────────────────────────────
# One image, two entrypoints: the API and the worker.
#
# They share it deliberately. The worker imports `@capella/api/services`, so a
# separate API image would have to contain the API anyway, and two images built
# from one lockfile drift the moment someone rebuilds only one of them.
#
# Based on the Playwright image because the worker drives a real headless
# Chromium. That is ~1.5GB and it is the reason this cannot be a serverless
# function: Chromium alone is 359MB unpacked, well past the ~250MB unzipped
# limit Vercel and Lambda impose.
#
# The tag must track the `playwright` version in package.json. A mismatch fails
# at runtime with "Executable doesn't exist" — the npm package looks for a
# browser build the image does not carry.
# ─────────────────────────────────────────────────────────────────────────────
FROM mcr.microsoft.com/playwright:v1.63.0-noble AS base
WORKDIR /app
ENV NODE_ENV=production

# ─── deps ────────────────────────────────────────────────────────────────────
# Manifests first so this layer caches until a dependency actually changes.
FROM base AS deps
COPY package.json package-lock.json ./
COPY packages/types/package.json      packages/types/
COPY packages/embedding/package.json  packages/embedding/
COPY packages/db/package.json         packages/db/
COPY packages/queue/package.json      packages/queue/
COPY packages/scraper/package.json    packages/scraper/
COPY apps/api/package.json            apps/api/
COPY apps/worker/package.json         apps/worker/
COPY apps/ui/package.json             apps/ui/

# `npm ci` needs devDependencies here: the build runs tsc and Prisma's
# generator. They are dropped again in the runtime stage.
RUN npm ci --include=dev

# ─── build ───────────────────────────────────────────────────────────────────
FROM deps AS build
COPY . .

# Prisma Client is generated code, not a package — without this every
# `import { PrismaClient }` resolves to an empty stub.
RUN npm run db:generate

# Compile the workspace packages and both apps. The UI is not built here; it is
# deployed separately to a static host (see vercel.json).
RUN npx tsc --build packages/types packages/embedding packages/db packages/queue \
      packages/scraper apps/api apps/worker

# Vendor the sentence-embedding weights into the image (~87MB).
#
# Without this the API downloads them from huggingface.co on first search. That
# is a cold-start stall, a hard dependency on an external host at request time,
# and it simply fails on a network-restricted host — which is what happened
# locally and is why this step exists.
RUN npm run embed:prewarm

# ─── runtime ─────────────────────────────────────────────────────────────────
FROM base AS runtime

# Drop build tooling: tsc, ts-jest, eslint and Prisma's generator engines are
# not needed to run, and they are most of the node_modules weight.
COPY --from=build /app/package.json /app/package-lock.json ./
COPY packages/types/package.json      packages/types/
COPY packages/embedding/package.json  packages/embedding/
COPY packages/db/package.json         packages/db/
COPY packages/queue/package.json      packages/queue/
COPY packages/scraper/package.json    packages/scraper/
COPY apps/api/package.json            apps/api/
COPY apps/worker/package.json         apps/worker/
COPY apps/ui/package.json             apps/ui/
RUN npm ci --omit=dev && npm cache clean --force

# Compiled output, the generated Prisma Client, and the model weights.
COPY --from=build /app/packages/types/dist      packages/types/dist
COPY --from=build /app/packages/embedding/dist  packages/embedding/dist
COPY --from=build /app/packages/db/dist         packages/db/dist
COPY --from=build /app/packages/queue/dist      packages/queue/dist
COPY --from=build /app/packages/scraper/dist    packages/scraper/dist
COPY --from=build /app/apps/api/dist            apps/api/dist
COPY --from=build /app/apps/worker/dist         apps/worker/dist
COPY --from=build /app/node_modules/.prisma     node_modules/.prisma
COPY --from=build /app/node_modules/@prisma/client node_modules/@prisma/client
COPY --from=build /app/.model-cache             .model-cache

# Migrations, so `npm run db:deploy` can run as a release step.
COPY packages/db/prisma packages/db/prisma

# Signed legal PDFs are written to disk (they are deliberately never sent to
# AEM). The default path is /var/capella-dam/legal-docs, which a non-root user
# cannot create — so the directory is made here and handed to pwuser. On a host
# with ephemeral disks this must be pointed at a mounted volume instead, or
# approvers lose the signed agreement when the container restarts.
RUN mkdir -p /var/capella-dam/legal-docs && chown -R pwuser:pwuser /var/capella-dam /app

# The Playwright image ships a non-root `pwuser`. Chromium's sandbox is safer
# under it, and nothing else here writes outside /app and /tmp.
USER pwuser

EXPOSE 3001

# Overridden to `node apps/worker/dist/index.js` for the worker service.
CMD ["node", "apps/api/dist/index.js"]
