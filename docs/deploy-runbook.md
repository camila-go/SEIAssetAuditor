# Deploy runbook — click by click

The what and why are in [`deployment.md`](./deployment.md). This is the where.

Roughly 20 minutes, most of it waiting for the first Docker build. Nothing here
needs AEM credentials — Phase 1 runs without them.

**Not paying for hosting?** Use [the free path](#the-free-path--no-render-no-cost).
It is what the published site uses today.

---

## The free path — no Render, no cost

The published site is a snapshot with no backend of its own. Audits still run
from the tool: someone opens **Audit**, pastes URLs (or uploads a CSV, or gives
a sitemap), and presses **Start audit**. The page shows progress, and when the
audit finishes the new findings load into the tool by themselves. Nobody using
the tool needs a GitHub account or ever sees GitHub.

Behind that, the crawl runs as a GitHub Actions job — the real scraper,
Postgres and Redis, for the minutes an audit takes — and the site's audit
service, `api/run-audit.mjs`, starts it and reports its progress. Public
repositories get unlimited Actions minutes and Vercel's Hobby plan includes
serverless functions, so none of this costs anything.

It needs two one-time settings, both done by whoever manages the Vercel
project. Until they are done, the Audit page says exactly which one is missing
and disables the button.

### 1. Root Directory must be the repository root

See [2a](#2a-fix-the-root-directory) below. The audit service lives at
`api/run-audit.mjs` in the repository root, and Vercel only deploys functions
inside the Root Directory. If this is wrong, the Audit page says the site was
*"published without its audit service"*.

### 2. Give the site its access key

The service needs a GitHub token to start the audit job. It is kept on the
server; it is never sent to anyone's browser.

**Make the token** → [github.com/settings/personal-access-tokens/new](https://github.com/settings/personal-access-tokens/new)

| Field | Value |
|---|---|
| Token name | `SEI Site Auditor — audit service` |
| Expiration | Your call. Audits stop starting on this date; set a reminder to replace it. |
| Repository access | **Only select repositories** → this repository only |
| Permissions → Repository → **Actions** | **Read and write** |

Nothing else. With only this, the worst a leaked token can do is start audits.

**Add it to Vercel** → your project → **Settings** → **Environment Variables** →
`GITHUB_TOKEN` = the token, for **Production**. Then **Redeploy**.

The repository is read from Vercel's own git metadata. Set `GITHUB_REPOSITORY`
(`owner/repo`) only if the site is deployed from somewhere other than this
repository — after a transfer to an SEI organisation, for example.

### If the Audit page reports a problem

| What it says | What to do |
|---|---|
| *"Audits cannot start on this site yet. It needs a one-time access key…"* | `GITHUB_TOKEN` is missing, or was added without redeploying. |
| *"…published without its audit service…"* | Root Directory is not the repository root. |
| *"…access key has expired or lacks permission…"* | Make a new token as above and replace `GITHUB_TOKEN`. |
| *"That list is too long to send in one audit"* | More than ~1,000 pasted URLs. Split it, or use the Sitemap tab. |

Limits: one audit at a time, up to 2,000 pages. The whole capella.edu sitemap
(1,527 pages) fits, and takes roughly two and a half hours.

---

## Step 1 — Backend on Render

**→ [dashboard.render.com](https://dashboard.render.com)**

1. Top right: **New** → **Blueprint**
2. Find `camila-go/SEIAssetAuditor` in the repo list → **Connect**
   - First time only: Render asks to install its GitHub app. Approve it for this
     repo.
3. On the setup screen:
   - **Blueprint Name** — anything, e.g. `sei-site-auditor`
   - **Branch** — `main`
   - **Blueprint Path** — leave as `render.yaml` (it is at the repo root)
4. Render reads the file and lists what it will create. You should see **four**
   resources:

   | | Name | Plan |
   |---|---|---|
   | Web service | `sei-site-auditor-api` | `1c-2g` |
   | Background worker | `sei-site-auditor-worker` | `2c-4g` |
   | Key Value | `sei-site-auditor-redis` | `free` |
   | Postgres | `sei-site-auditor-db` | `0.1c-256mb` |

   If you see an error about a plan name instead, the blueprint is out of date —
   pull the latest `main`.

5. Render prompts for every variable the file marks `sync: false`. **Only two
   matter right now.** Leave every AEM, OpenAI, Anthropic and SMTP field blank.

   | Variable | Value |
   |---|---|
   | `UI_ORIGIN` | your Vercel URL, exactly — `https://sei-asset-auditor-api.vercel.app`, no trailing slash |
   | `INTERNAL_AUTH_TOKEN` | any long random string (generate one below) |

   ```bash
   node -e "console.log(require('crypto').randomBytes(36).toString('base64url'))"
   ```

   If it does not prompt, set them afterwards: click the service → **Environment**
   in the left sidebar → **Add Environment Variable**.

6. **Deploy Blueprint**

The first build takes a while — it is a ~1.5GB Playwright image, and it vendors
the embedding model. Watch it under the API service → **Logs**.

### Check it worked

Copy the API's URL from the top of its page (something like
`https://sei-site-auditor-api.onrender.com`), then:

```bash
curl https://sei-site-auditor-api.onrender.com/health
```

Expect `{"data":{"status":"ok","phase":{...}}}`. Anything else — read the
service's **Logs** tab before changing anything.

---

## Step 2 — Point the UI at it

**→ [vercel.com/dashboard](https://vercel.com/dashboard)** → your project

### 2a. Fix the Root Directory

**Settings** → **General** → **Build and development settings** → **Root
Directory**

Set it to the **repository root** — clear the field, or `./`. It is currently
`apps/api`, which is why `vercel.json` is being ignored entirely.

While you are there, make sure **Build Command**, **Output Directory** and
**Install Command** are *not* overridden. A dashboard override silently beats
the file.

### 2b. Add the API origin

**Settings** → **Environment Variables** → **Add**

| Key | Value | Environments |
|---|---|---|
| `VITE_API_ORIGIN` | the Render API URL from step 1 | Production, Preview, Development |

No trailing slash. It must match `UI_ORIGIN` on Render **exactly**.

### 2c. Redeploy

Vercel's own docs: *"The changes you make to these settings will only be applied
starting from your next deployment."* `VITE_API_ORIGIN` is read at **build**
time, so saving it changes nothing until you rebuild.

**Deployments** tab → most recent → **⋯** → **Redeploy**.

---

## Step 3 — Prove the whole chain

Open the Vercel URL and run an audit of one URL, e.g.
`https://www.capella.edu/online-degrees/`. That single action exercises the UI, the API,
Redis, the worker, Chromium and Postgres in order.

| What you see | What it means |
|---|---|
| Results appear | Everything works. |
| *"The API is not reachable at this address"* | `VITE_API_ORIGIN` is unset or the redeploy has not happened. |
| Network errors, nothing in the console | CORS. `UI_ORIGIN` and `VITE_API_ORIGIN` do not match exactly. |
| Job stays **queued** forever | The worker is not running or cannot reach Redis. Check the worker's **Logs**. |

---

## Things that will catch you out

**The two origins must match character for character.** This is the single most
likely mistake. `https://x.vercel.app` and `https://x.vercel.app/` are different
values, and the only symptom is every request failing preflight with nothing
useful in the browser console.

**Render free services sleep.** The API is on a paid plan so it does not, but if
you downgrade it, the first request after idle takes ~50 seconds and looks like
a hang.

**The first audit on a fresh database finds nothing to fingerprint.** That is
correct — fingerprinting and embedding are queued automatically when the audit
completes, and coverage climbs over the following minutes.

**Nothing is public.** Postgres and Redis both have `ipAllowList: []`. That is
deliberate; this tool holds a map of the site and, eventually, AEM credentials.

---

## When you do add AEM credentials

Stop and read [`dam-permissions.md`](./dam-permissions.md) first. Putting real
service-account credentials on a third-party host is a procurement and security
decision at SEI, not just a settings change — and the account has to be scoped
before it is issued, not after.
