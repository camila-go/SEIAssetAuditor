# Deploy runbook — click by click

The what and why are in [`deployment.md`](./deployment.md). This is the where.

Roughly 20 minutes, most of it waiting for the first Docker build. Nothing here
needs AEM credentials — Phase 1 runs without them.

**Not paying for hosting?** Skip to [the free path](#the-free-path--no-render-no-cost)
first. It is what the published site uses today.

---

## The free path — no Render, no cost

The published site is a snapshot with no backend. Audits run in GitHub
Actions — the real scraper, Postgres and Redis, started for the minutes an audit
takes — and the refreshed index is committed back, which rebuilds the site.

Public repositories get unlimited Actions minutes. Vercel's Hobby plan includes
serverless functions. Nothing below costs anything.

### What works with no setup at all

Open **Audit** on the published site. You can paste URLs or upload a CSV, and the
**Recent runs** list shows every audit run live from GitHub, with its status.

The button reads **Copy N URLs and open GitHub**. It puts the URLs on your
clipboard and opens the workflow; choose **Run workflow**, paste, confirm. Two
clicks, and no token anywhere.

The repository is detected at build time from Vercel's own git metadata, so
there is nothing to configure for this part.

### One click instead of two (optional)

Starting the run directly from the tool needs a GitHub token. It cannot go in the
page — anyone can read a static bundle — so it lives in a serverless function,
`api/run-audit.mjs`, which the page posts the URLs to.

**1. Make the token** → [github.com/settings/personal-access-tokens/new](https://github.com/settings/personal-access-tokens/new)

| Field | Value |
|---|---|
| Token name | `SEI Site Auditor — start audits` |
| Expiration | Your call. It stops working silently on this date; set a reminder. |
| Repository access | **Only select repositories** → this repository only |
| Permissions → Repository → **Actions** | **Read and write** |

Nothing else. With only `actions: write` on one repository, the worst a leaked
token can do is start audits.

**2. Give it to Vercel** → your project → **Settings** → **Environment
Variables**. Add all three, for **Production**:

| Name | Value |
|---|---|
| `GITHUB_TOKEN` | the token from step 1 |
| `GITHUB_REPOSITORY` | `owner/repo`, e.g. `camila-go/SEIAssetAuditor` |
| `VITE_GITHUB_DISPATCH_URL` | `/api/run-audit` |

The first two are read only by the function, on the server. The third is baked
into the page and tells it the function exists — it is a path, not a secret.

**3. Check the Root Directory is the repository root.** See [2a](#2a-fix-the-root-directory).
The function is at `api/run-audit.mjs` in the repository root, and Vercel only
deploys functions from inside the Root Directory. While it is set to `apps/api`,
the page will show the one-click button and the function will not exist.

**4. Redeploy**, then open **Audit**. The button now reads **Run N URLs on
GitHub**, and the run appears under **Recent runs** within a few seconds.

| What you see | What it means |
|---|---|
| *"This deployment has no GitHub token"* | `GITHUB_TOKEN` or `GITHUB_REPOSITORY` is missing, or was added after the last deploy. |
| *"GitHub refused the request…"* | The token lacks **Actions: Read and write** on this repository, or has expired. GitHub answers 404 rather than 403 for a repository a token cannot see. |
| *"…(HTTP 404)"* with no explanation | The function is not deployed. Almost always the Root Directory. |
| Button still says **Copy … and open GitHub** | `VITE_GITHUB_DISPATCH_URL` was not set when the site was built. Redeploy. |

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
