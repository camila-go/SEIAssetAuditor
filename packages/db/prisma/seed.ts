/**
 * `npm run db:seed` — a small, realistic dataset so the UI can be developed
 * before anyone has run a real audit against capella.edu.
 *
 * Paths follow Capella's real DAM conventions but reference nothing in
 * particular. Safe to run repeatedly: everything upserts.
 */
import { loadEnvFile } from 'node:process'
import { PrismaClient } from '@prisma/client'

// The Prisma CLI loads .env for migrate/studio, but this script runs under tsx,
// which does not — without this, DATABASE_URL is undefined at client init.
try {
  loadEnvFile()
} catch {
  // No .env — rely on real environment variables.
}

const prisma = new PrismaClient()

const PAGES = [
  { url: 'https://www.capella.edu/online-degrees/', title: 'Online Degrees', isPublished: true },
  {
    url: 'https://www.capella.edu/online-degrees/masters-nursing/',
    title: 'Master of Science in Nursing',
    isPublished: true,
  },
  {
    url: 'https://www.capella.edu/online-degrees/doctoral-psychology/',
    title: 'PhD in Psychology',
    isPublished: true,
  },
  { url: 'https://www.capella.edu/about/', title: 'About Capella', isPublished: true },
  {
    url: 'https://www.capella.edu/online-degrees/bachelors-business/',
    title: 'Bachelor of Science in Business',
    isPublished: false,
  },
]

/**
 * Real DAM paths, confirmed to resolve on capella.edu.
 *
 * They were invented at first, which meant the pHash job could never fetch
 * them: image-index coverage sat permanently below 100% and the "not all
 * images are fingerprinted" warning never cleared, training people to ignore
 * it. Seeding paths that actually exist means the sweep completes.
 */
const ASSETS = [
  '/content/dam/capella/logos/capella_logo_horizontal_RGB_448x95.svg',
  '/content/dam/capella/logos/think-education.png',
  '/content/dam/capella/blog/hero_browsinglaptopdog_320x181.jpg',
  '/content/dam/capella/cu-brand-campaign/OnlineDegrees-DT.jpg',
  '/content/dam/capella/PDF/FactSheet.pdf',
]

const TESTIMONIALS = [
  {
    quoteText:
      'The flexibility of the program meant I could keep working full time while finishing my degree, and my clinical instructors genuinely cared whether I understood the material.',
    studentName: 'Marcus Webb',
    program: 'Master of Science in Nursing',
    degreeLevel: 'masters',
    sourceType: 'structured_component' as const,
    pages: [1, 0],
  },
  {
    quoteText:
      'I came back to school after fifteen years away and I was terrified. My advisor walked me through every single step until it stopped feeling impossible.',
    studentName: 'Danielle Okoro',
    program: 'PhD in Psychology',
    degreeLevel: 'doctoral',
    sourceType: 'hardcoded_text' as const,
    pages: [2],
  },
  {
    quoteText:
      'What surprised me most was how much the coursework applied directly to my job. I was using what I learned the same week I learned it.',
    studentName: null,
    program: null,
    degreeLevel: null,
    sourceType: 'hardcoded_text' as const,
    pages: [0, 3],
  },
]

/** Mirrors `fingerprint()` in packages/scraper — kept in sync deliberately. */
function fingerprint(quote: string): string {
  return quote
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function assetTypeFor(path: string) {
  if (/\.(jpg|jpeg|png|gif|webp|svg)$/i.test(path)) return 'image' as const
  if (/\.(mp4|mov|webm)$/i.test(path)) return 'video' as const
  if (/\.(pdf|docx?)$/i.test(path)) return 'document' as const
  return 'other' as const
}

async function main(): Promise<void> {
  const now = new Date()

  const pages = []
  for (const page of PAGES) {
    pages.push(
      await prisma.page.upsert({
        where: { url: page.url },
        create: { ...page, lastCrawledAt: now },
        update: { ...page, lastCrawledAt: now },
      }),
    )
  }

  const assets = []
  for (const aemPath of ASSETS) {
    assets.push(
      await prisma.asset.upsert({
        where: { aemPath },
        create: {
          aemPath,
          filename: aemPath.split('/').pop() ?? aemPath,
          assetType: assetTypeFor(aemPath),
          lastSeenAt: now,
          isIndexed: true,
        },
        update: { lastSeenAt: now },
      }),
    )
  }

  // Deliberately NOT seeding fake pHash values. They were 64-bit while the real
  // hasher emits 256-bit, so every comparison against a real asset returned
  // Infinity — the rows looked hashed but could never match anything. Run
  // `npm run crawl` (or the "Fingerprint the rest" button) to hash these for
  // real, over the public URLs.

  for (const [index, asset] of assets.entries()) {
    const page = pages[index % pages.length]
    if (!page) continue
    await prisma.assetPageReference.upsert({
      where: { assetId_pageId: { assetId: asset.id, pageId: page.id } },
      create: { assetId: asset.id, pageId: page.id },
      update: {},
    })
  }

  for (const testimonial of TESTIMONIALS) {
    const record = await prisma.testimonial.upsert({
      where: { quoteFingerprint: fingerprint(testimonial.quoteText) },
      create: {
        quoteText: testimonial.quoteText,
        quoteFingerprint: fingerprint(testimonial.quoteText),
        studentName: testimonial.studentName,
        program: testimonial.program,
        degreeLevel: testimonial.degreeLevel,
        sourceType: testimonial.sourceType,
        rawHtml: `<blockquote>${testimonial.quoteText}</blockquote>`,
        firstSeenAt: now,
        lastSeenAt: now,
      },
      update: { lastSeenAt: now },
    })

    for (const [position, pageIndex] of testimonial.pages.entries()) {
      const page = pages[pageIndex]
      if (!page) continue
      await prisma.testimonialPageReference.upsert({
        where: { testimonialId_pageId: { testimonialId: record.id, pageId: page.id } },
        create: { testimonialId: record.id, pageId: page.id, positionOnPage: position },
        update: {},
      })
    }
  }

  // A completed audit job so /audit and the dashboard aren't empty.
  const job = await prisma.auditJob.create({
    data: {
      name: 'Seed audit — 5 URLs',
      status: 'complete',
      inputType: 'paste',
      totalUrls: PAGES.length,
      completedUrls: PAGES.length,
      startedAt: now,
      completedAt: now,
    },
  })

  await prisma.auditJobUrl.createMany({
    data: PAGES.map((page) => ({
      jobId: job.id,
      url: page.url,
      status: 'done' as const,
      processedAt: now,
      pageTitle: page.title,
      isPublished: page.isPublished,
      assetCount: 1,
      testimonialCount: 1,
    })),
  })

  console.log(
    `Seeded ${pages.length} pages, ${assets.length} assets, ${TESTIMONIALS.length} testimonials, 1 audit job.`,
  )
}

main()
  .catch((error: unknown) => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
