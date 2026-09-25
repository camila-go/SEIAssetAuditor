/**
 * Export and restore the indexed data.
 *
 * The index is the expensive part of this tool. It is 111 real capella.edu
 * pages, 779 assets, 665 fingerprints and 46 testimonials, and it took real
 * crawling to build — but it lived only in a Postgres instance on one laptop.
 * A machine being reimaged would have taken it, and a fresh clone of the repo
 * came up empty, which makes the tool look like a shell rather than something
 * with findings in it.
 *
 * Written through Prisma rather than `pg_dump` because the embedded Postgres
 * used for local development ships only `initdb`, `pg_ctl` and `postgres` —
 * there is no dump binary to call. Going through the client also means the
 * snapshot is plain JSON, readable without a database and portable across
 * Postgres versions.
 *
 * Nothing here is personal data: public DAM paths, public page URLs, and quotes
 * already published on capella.edu. Video submissions are exported too but the
 * table is empty and intake is off; if that ever changes, that table holds
 * submitter names, emails and IP addresses and must NOT be committed.
 *
 *   npm run db:snapshot   — write packages/db/prisma/snapshot/
 *   npm run db:restore    — load it into an empty database
 */
import { gunzipSync, gzipSync } from 'node:zlib'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { prisma } from '../src/client.js'

const SNAPSHOT_DIR = join(dirname(new URL(import.meta.url).pathname), '..', 'prisma', 'snapshot')

/**
 * Order matters on restore: a row cannot reference a parent that is not there
 * yet. Exported in the same order so the file listing reads as the dependency
 * chain rather than alphabetically.
 */
const TABLES = [
  'auditJob',
  'page',
  'asset',
  'testimonial',
  'auditJobUrl',
  'assetPageReference',
  'testimonialPageReference',
] as const

type TableName = (typeof TABLES)[number]

/** Video submissions are deliberately absent — see the note at the top. */
function client(table: TableName): { findMany: (args?: unknown) => Promise<unknown[]>; createMany: (args: unknown) => Promise<unknown> } {
  return (prisma as unknown as Record<TableName, never>)[table]
}

async function exportSnapshot(): Promise<void> {
  mkdirSync(SNAPSHOT_DIR, { recursive: true })

  let total = 0

  for (const [index, table] of TABLES.entries()) {
    const rows = await client(table).findMany()
    total += rows.length

    // Gzipped because embeddings dominate the size: 384 floats per row is a
    // few KB of JSON that compresses to almost nothing, and an uncompressed
    // snapshot is a multi-megabyte diff on every refresh.
    const name = `${String(index).padStart(2, '0')}-${table}.json.gz`
    writeFileSync(join(SNAPSHOT_DIR, name), gzipSync(JSON.stringify(rows), { level: 9 }))

    console.log(`  ${name.padEnd(40)} ${String(rows.length).padStart(6)} rows`)
  }

  console.log(`\nWrote ${total} rows to ${SNAPSHOT_DIR}`)
}

async function restoreSnapshot(): Promise<void> {
  if (!existsSync(SNAPSHOT_DIR)) {
    console.error(`No snapshot at ${SNAPSHOT_DIR}. Run \`npm run db:snapshot\` first.`)
    process.exit(1)
  }

  const files = readdirSync(SNAPSHOT_DIR).filter((f) => f.endsWith('.json.gz')).sort()
  let total = 0

  for (const file of files) {
    const table = file.replace(/^\d+-/, '').replace(/\.json\.gz$/, '') as TableName
    const rows = JSON.parse(gunzipSync(readFileSync(join(SNAPSHOT_DIR, file))).toString()) as unknown[]
    if (rows.length === 0) continue

    // `skipDuplicates` so restoring over an existing index tops it up rather
    // than failing on the first unique-constraint collision.
    await client(table).createMany({ data: rows, skipDuplicates: true })
    total += rows.length
    console.log(`  ${file.padEnd(40)} ${String(rows.length).padStart(6)} rows`)
  }

  console.log(`\nRestored ${total} rows.`)
}

const mode = process.argv[2]

try {
  if (mode === 'export') await exportSnapshot()
  else if (mode === 'restore') await restoreSnapshot()
  else {
    console.error('Usage: snapshot.ts <export|restore>')
    process.exit(1)
  }
} finally {
  await prisma.$disconnect()
}
