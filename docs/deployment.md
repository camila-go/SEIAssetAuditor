# Deployment

The UI is a static build on Vercel. The API and worker are containers on Render,
with Postgres and Redis alongside them.

## Why it is split

Vercel cannot run this whole tool, and the build error that surfaced it
(`tsc: command not found`) was the least of the reasons. Measured against this
repo:

| What the backend needs | Serverless |
|---|---|
| Chromium for Playwright — **359MB** unpacked (195MB headless shell) | ~250MB unzipped function limit |
| Sentence-embedding weights — **87MB**, gitignored, not in the repo | re-downloaded on every cold start |
| `apps/worker`: a persistent BullMQ consumer | no long-running processes |
| A 1000-URL audit: 60–90 minutes | timeouts measured in minutes |
| Video intake streams up to 2GB | ~4.5MB request body cap |

The worker settles it. It is a daemon waiting on a Redis queue, so on a
serverless host **no audit would ever run**, however green the build went.

The UI is genuinely a good fit for Vercel, so it stays there.

> **Doing it right now?** [`deploy-runbook.md`](./deploy-runbook.md) is the
> click-by-click version — exact menus, exact values, what to check at each
> step. This page is the reasoning behind it.

## First deploy

### 1. Backend — Render

Render → **New** → **Blueprint** → pick this repo. It reads `render.yaml` and
creates four resources: the API (web), the worker, Postgres 17, and a Key Value
(Redis) instance. `DATABASE_URL` and `REDIS_URL` are wired between them
automatically — you never paste a connection string.

The plans in the blueprint are Render's current compute identifiers. The older
names (`starter`, `standard`, `basic-256mb`) are rejected by the blueprint
parser, so this file was corrected against the spec before first use:

| Resource | Plan | Why that one |
|---|---|---|
| API | `1c-2g` | The sentence-embedding model holds ~90MB resident before Node, Prisma and sharp. `0.5c-512mb` is too tight. |
| Worker | `2c-4g` | Chromium at `SCRAPER_CONCURRENCY=5`. On a smaller plan the OOM killer takes the browser mid-audit, and it surfaces as every URL in a batch failing for no stated reason. |
| Key Value | `free` | BullMQ stores job metadata, not payloads. |
| Postgres | `0.1c-256mb` | **Not `free`** — Render deletes a free Postgres after 30 days, and a demo that silently loses its index a month in is worse than one that costs a few dollars. |

Postgres and Key Value both have `ipAllowList: []`, which blocks all external
connections. Nothing outside Render's private network needs to reach either, and
this tool holds AEM credentials and a map of the site.

Set the values marked `sync: false` in the dashboard **before** the first
deploy. Only two matter to get a running Phase 1 tool:

- `UI_ORIGIN` — the Vercel URL, exactly, scheme included, no trailing slash
- `INTERNAL_AUTH_TOKEN` — any long random string; it gates the `/admin` routes.
  Generate one with `node -e "console.log(require('crypto').randomBytes(36).toString('base64url'))"`

Set them on **both** the API and the worker where both lists include them — the
worker needs the AEM credentials, the API needs `UI_ORIGIN`.

Every AEM and API credential can stay unset. Phase 2 and 3 return a structured
`501` and the UI shows an explanatory notice.

Migrations run as a pre-deploy step (`prisma migrate deploy`), which only
applies committed migrations — it can never reset the database the way
`migrate dev` can.

### 2. Frontend — Vercel

Same repo, **Root Directory left at the repository root**. `vercel.json` does
the rest.

**Which build you get is decided by `VITE_API_ORIGIN`, not by a build command.**

- Unset → the read-only snapshot, which needs no backend.
- Set → the live UI, pointed at that origin.

That choice lives in `scripts/build-ui.mjs` rather than in `vercel.json` on
purpose. A host's dashboard settings override that file, and when its Root
Directory points inside a workspace the file is not read at all — which is how a
live-API build reached production with no API behind it, answering every request
with its own HTML and a 200. Deciding from the environment means the deployment
cannot end up in that state whatever the dashboard says.

To go live: set `VITE_API_ORIGIN` and redeploy. Nothing else changes.

`install:ui`, `build:ui` and `build:static` all exist in the root, `apps/api`
and `apps/ui` manifests, and all delegate to the same two scripts. Which command
Vercel actually runs is not visible from the repo — `vercel.json` says one
thing, a dashboard override says another, and the Root Directory decides whether
the file is read at all. Rather than guess, every combination resolves to the
same correct build. Confirmed across all six: three roots by the commands each
might be given.

> **The Root Directory must be the repository root.** This has now broken the
> build twice, with two different-looking errors and one cause:
>
> | Error | What it actually means |
> |---|---|
> | `sh: tsc: command not found` | Root Directory is inside a workspace, so npm never installed the workspace root — and `typescript` is a root devDependency |
> | `npm error Missing script: "build:ui"` + `location /vercel/path0/apps/api` | Same thing. `build:ui` is defined in the root `package.json`, not in `apps/api` |
>
> The giveaway in both is the `location` line: if it ends in `/apps/api` or
> `/apps/ui`, the Root Directory is wrong regardless of what the error says.
>
> No repository change can work around this. With the Root Directory inside a
> workspace, `outputDirectory: apps/ui/dist` resolves to
> `apps/api/apps/ui/dist`, which will never exist. Set it to the repository
> root and leave Build Command and Output Directory blank so `vercel.json`
> supplies them.

#### The repo now survives the wrong Root Directory

`vercel.json` runs `npm run install:ui` and `npm run build:ui`, and both exist in
the root, `apps/api` and `apps/ui` manifests. They delegate to
`scripts/install-ui.mjs` / `scripts/build-ui.mjs`, which walk up to the real
workspace root, work there, and — only when started somewhere else — mirror the
build output back so `outputDirectory` resolves either way.

This is a safety net, not the fix. **Set the Root Directory correctly.** The
scripts print a warning pointing here when they have to compensate, and the
mirror directory is gitignored. Once the setting is right they are no-ops.

Set one environment variable:

- `VITE_API_ORIGIN` — the Render API URL, e.g. `https://sei-site-auditor-api.onrender.com`

It is read at **build time**, not runtime, so changing it needs a redeploy.

#### Why the install is scoped

`installCommand` is `npm ci --workspace=@capella/ui --include-workspace-root`
rather than a plain install. Unscoped, Vercel installs every workspace —
including `onnxruntime-node` and `sharp` from the embedding package, and
Playwright — to build a static frontend that needs none of them. Measured on a
clean clone of this repo:

| | Unscoped | Scoped |
|---|---|---|
| `node_modules` | 833 MB | **259 MB** |
| packages | 518 | **340** |
| build output | 42 files | 42 files, byte-identical |

`npm ci` rather than `npm install` so the lockfile is authoritative: a drifted
lockfile fails the build loudly instead of quietly resolving something the
lockfile never described.

Note that `vercel.json` carries no comments — Vercel validates it against a
schema, and an unknown key is one more way for this file to fail. The reasoning
lives here instead.

### 3. Make the two agree

`VITE_API_ORIGIN` (Vercel) points at the API. `UI_ORIGIN` (Render) allows the
UI. If they disagree, every request fails CORS preflight and the UI shows
generic network errors with nothing useful in its console. This is the single
most likely thing to get wrong.

## "HTTP 405" when starting an audit

The interface is deployed; the backend is not. Nothing else causes it.

A static host serves the UI and has no `/api`, so with `VITE_API_ORIGIN` unset
the UI calls its own origin and the host answers:

| Request | What a static host does | How it used to read |
|---|---|---|
| `GET /api/v1/assets/stats` | returns the SPA's `index.html` with **200** | "Server returned a non-JSON response (HTTP 200)" |
| `POST /api/v1/audit` | **405**, because static hosting allows only GET and HEAD | "HTTP 405" |

Two unrelated-looking errors, one missing deployment. The UI now recognises both
and says so (`API_NOT_REACHABLE`), but the fix is the same: **deploy the backend
and point the UI at it.** A static host cannot run this tool — the worker is a
daemon that drives a headless Chromium, and no amount of Vercel configuration
changes that.

Note that Vercel only applies this repo's `vercel.json` when the Root Directory
is the repository root. With it set elsewhere the rewrites are ignored entirely,
which is why `/api/*` returns the app shell on the current deployment.

## Verifying

```bash
curl https://<api-host>/health
```

Should report `{"status":"ok"}` and the phase flags. Then load the Vercel URL
and open the browser network tab — requests should go to the Render host and
return 200, not fail preflight.

A real check is to run an audit of one URL: it exercises the API, Redis, the
worker, Chromium and Postgres in one go. If the job stays `queued`, the worker
is not running or cannot reach Redis.

## Things that will bite

**The Playwright image tag must match the installed `playwright` version.**
The Dockerfile pins `v1.63.0-noble` against the lockfile's 1.63.0. Bump one
without the other and the worker dies at runtime with "Executable doesn't
exist" — the npm package looks for a browser build the image does not carry.

**The worker needs more than 512MB.** Chromium with `SCRAPER_CONCURRENCY=5` will
be OOM-killed on the starter plan, and it surfaces as every URL in a batch
failing with no stated cause. `render.yaml` puts the worker on `standard` for
this reason.

**Signed legal PDFs need the mounted disk.** They are deliberately never sent to
AEM, so without the disk they vanish on each deploy and an approver clicking
"View signed document" gets a 404 for an agreement that really was filed.

**Redis must not evict.** BullMQ is not a cache — an evicted key is a lost audit
job. `maxmemoryPolicy: noeviction` makes Redis refuse writes instead of silently
dropping queued work.

**Video intake will not work through a CDN proxy.** The UI posts uploads
directly to the API origin for this reason; routing a 2GB upload through
Vercel would hit its body limit.

## Not verified

Docker is not installed on the machine this was written on, so **the image has
never been built**. The Dockerfile is reasoned from the repo's real dependency
graph, not proven. Expect the first `docker build` to need a fix or two —
likely candidates are the Playwright base tag and the `npm ci --omit=dev` step
in the runtime stage, which needs every workspace manifest present even for
workspaces it does not install.

The split-origin CORS path has also only been exercised locally through the Vite
proxy, not across two real hosts.

## Before this is a production tool

Deploying it does not make it ready. See the README's "Before this can go live"
and `docs/dam-permissions.md`: the two AEM service accounts, the dispatcher rule
blocking the intake staging folder, Legal's sign-off on the agreement copy, and
replacing the shared approver token with real SSO.

One more, specific to hosting: this tool holds AEM service-account credentials.
Putting it on a third-party host is a security and procurement decision at SEI,
not only a technical one.
