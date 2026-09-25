#!/usr/bin/env node
/**
 * Turn the committed index snapshot into a single JSON file the UI can read
 * with no backend at all.
 *
 * This is what makes a free, always-on, account-independent demo possible. The
 * tool proper needs a persistent worker driving a headless Chromium plus
 * Postgres and Redis that survive restarts — none of which exists on a free
 * tier. But everything the index already *knows* is static data, and a static
 * host serves that for nothing, forever.
 *
 * Reads `packages/db/prisma/snapshot/`, not a live database, so it runs on a
 * build machine that has never seen Postgres.
 *
 * Embeddings are dropped: 2,651KB of the snapshot is 384-float vectors that a
 * browser cannot use without the model. Without them the whole payload is about
 * 210KB gzipped. Semantic search is therefore absent in static mode rather than
 * silently degraded, and the UI says so.
 */
import { gunzipSync } from 'node:zlib'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

function findWorkspaceRoot(from) {
  let dir = resolve(from)
  for (;;) {
    const manifest = join(dir, 'package.json')
    if (existsSync(manifest)) {
      try {
        if (JSON.parse(readFileSync(manifest, 'utf8')).workspaces) return dir
      } catch {
        /* keep walking */
      }
    }
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

const root = findWorkspaceRoot(process.cwd())
if (root === null) {
  console.error('[static-data] No workspace root found.')
  process.exit(1)
}

const SNAPSHOT = join(root, 'packages', 'db', 'prisma', 'snapshot')
const OUT_DIR = join(root, 'apps', 'ui', 'public', 'data')

function read(name) {
  const file = join(SNAPSHOT, name)
  if (!existsSync(file)) {
    console.error(`[static-data] Missing ${file}. Run \`npm run db:snapshot\` on a machine with the database.`)
    process.exit(1)
  }
  return JSON.parse(gunzipSync(readFileSync(file)).toString())
}

const assets = read('02-asset.json.gz')
const pages = read('01-page.json.gz')
const testimonials = read('03-testimonial.json.gz')
const refs = read('05-assetPageReference.json.gz')
const testimonialRefs = read('06-testimonialPageReference.json.gz')
const auditJobs = read('00-auditJob.json.gz')
const auditJobUrls = read('04-auditJobUrl.json.gz')

// Only what a read-only view actually renders. Dropping `embedding` and
// `rawHtml` is most of the saving.
const leanAssets = assets.map((a) => ({
  id: a.id,
  aemPath: a.aemPath,
  filename: a.filename,
  assetType: a.assetType,
  fileSize: a.fileSize,
  width: a.width,
  height: a.height,
  phash: a.phash,
  phashAlt: a.phashAlt,
  lastSeenAt: a.lastSeenAt,
  lastVerifiedAt: a.lastVerifiedAt,
  lastVerifiedStatus: a.lastVerifiedStatus,
}))

const leanTestimonials = testimonials.map((t) => ({
  id: t.id,
  quoteText: t.quoteText,
  studentName: t.studentName,
  program: t.program,
  degreeLevel: t.degreeLevel,
  sourceType: t.sourceType,
  needsReview: t.needsReview,
  firstSeenAt: t.firstSeenAt,
  lastSeenAt: t.lastSeenAt,
}))

const leanPages = pages.map((p) => ({
  id: p.id,
  url: p.url,
  title: p.title,
  isPublished: p.isPublished,
  crawledAt: p.crawledAt,
}))

const payload = {
  /** Stamped so the UI can say how old this is without guessing. */
  generatedAt: new Date().toISOString(),
  assets: leanAssets,
  pages: leanPages,
  testimonials: leanTestimonials,
  assetPageReferences: refs.map((r) => ({ assetId: r.assetId, pageId: r.pageId })),
  testimonialPageReferences: testimonialRefs.map((r) => ({
    testimonialId: r.testimonialId,
    pageId: r.pageId,
  })),
  // Per-URL rows, so a job page — including its failures — opens without an
  // API. The dashboard links straight at these, and without them those links
  // landed on a 501.
  auditJobUrls: auditJobUrls.map((u) => ({
    id: u.id,
    jobId: u.jobId,
    url: u.url,
    status: u.status,
    error: u.error,
    assetCount: u.assetCount,
    testimonialCount: u.testimonialCount,
    pageTitle: u.pageTitle,
    isPublished: u.isPublished,
    processedAt: u.processedAt,
  })),
  auditJobs: auditJobs.map((j) => ({
    id: j.id,
    name: j.name,
    status: j.status,
    totalUrls: j.totalUrls,
    completedUrls: j.completedUrls,
    failedUrls: j.failedUrls,
    createdAt: j.createdAt,
    completedAt: j.completedAt,
    errorMessage: j.errorMessage,
  })),
}

mkdirSync(OUT_DIR, { recursive: true })
const out = join(OUT_DIR, 'index.json')
writeFileSync(out, JSON.stringify(payload))

const kb = (readFileSync(out).length / 1024).toFixed(0)
console.log(
  `[static-data] ${out}\n` +
    `[static-data] ${payload.assets.length} assets · ${payload.pages.length} pages · ` +
    `${payload.testimonials.length} testimonials · ${payload.assetPageReferences.length} references\n` +
    `[static-data] ${kb}KB uncompressed (servers gzip this to roughly a tenth)`,
)
