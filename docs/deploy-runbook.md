# Deploy runbook — click by click

The what and why are in [`deployment.md`](./deployment.md). This is the where.

Roughly 20 minutes, most of it waiting for the first Docker build. Nothing here
needs AEM credentials — Phase 1 runs without them.

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
`https://www.capella.edu/about/`. That single action exercises the UI, the API,
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
