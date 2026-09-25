// Local stand-in for the Vercel deployment: serves the static build and mounts
// the real api/run-audit.mjs handler. GitHub is simulated (MOCK_GITHUB=1) so a
// full audit can be followed without dispatching a real run.
//
//   MOCK_GITHUB=1 GITHUB_TOKEN=fake PORT=4190 node scripts/.local-audit-server.mjs
//
// Build first with `BUILD_STATIC=1 npm run build:ui`. Without GITHUB_TOKEN it
// shows the "needs a one-time access key" state instead.
import { createServer } from 'node:http'
import { readFileSync, existsSync, writeFileSync } from 'node:fs'
import { join, extname } from 'node:path'
import handler from '../api/run-audit.mjs'

const DIST = new URL('../apps/ui/dist/', import.meta.url).pathname
const PORT = Number(process.env.PORT ?? 4180)
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml' }

if (process.env.MOCK_GITHUB === '1') {
  let dispatchedAt = null
  const realFetch = globalThis.fetch
  // Compressed timeline, in seconds after dispatch.
  const stepAt = (t) =>
    t < 6 ? null : t < 12 ? 'Build' : t < 24 ? 'Run the audit' : t < 30 ? 'Let the fingerprint and embedding sweeps finish' : t < 36 ? 'Commit it' : 'done'
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url)
    if (!u.startsWith('https://api.github.com/')) return realFetch(url, init)
    if (u.endsWith('/dispatches')) {
      dispatchedAt = Date.now()
      console.log('[mock] dispatch inputs', JSON.parse(init.body).inputs)
      return new Response(null, { status: 204 })
    }
    const t = dispatchedAt ? (Date.now() - dispatchedAt) / 1000 : -1
    const step = stepAt(t)
    if (u.includes('/runs?')) {
      const runs = dispatchedAt ? [{
        id: 1, display_title: 'Local test', event: 'workflow_dispatch',
        status: step === null ? 'queued' : step === 'done' ? 'completed' : 'in_progress',
        conclusion: step === 'done' ? 'success' : null,
        created_at: new Date(dispatchedAt).toISOString(), updated_at: new Date().toISOString(),
      }] : []
      if (step === 'done' && t > 44) {
        // Simulate the site rebuilding with the new findings.
        writeFileSync(join(DIST, 'data/version.json'), JSON.stringify({ generatedAt: 'rebuilt-' + dispatchedAt }))
      }
      return Response.json({ workflow_runs: runs })
    }
    if (u.includes('/jobs')) {
      return Response.json({ jobs: [{ steps: step && step !== 'done' ? [{ name: step, status: 'in_progress' }] : [] }] })
    }
    return new Response('{}', { status: 404 })
  }
}

createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`)
  if (url.pathname === '/api/run-audit') {
    let raw = ''
    for await (const chunk of req) raw += chunk
    const shim = {
      statusCode: 200, headers: {},
      setHeader(k, v) { this.headers[k] = v },
      status(c) { this.statusCode = c; return this },
      json(b) { res.writeHead(this.statusCode, { ...this.headers, 'Content-Type': 'application/json' }); res.end(JSON.stringify(b)) },
    }
    return handler({ method: req.method, url: req.url, query: Object.fromEntries(url.searchParams), body: raw }, shim)
  }
  let file = join(DIST, url.pathname)
  if (!existsSync(file) || url.pathname === '/' || !extname(file)) file = join(DIST, 'index.html')
  res.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' })
  res.end(readFileSync(file))
}).listen(PORT, () => console.log(`local audit server on ${PORT}`))
