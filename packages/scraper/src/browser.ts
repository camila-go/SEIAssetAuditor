import { chromium, type Browser, type BrowserContext } from 'playwright'
import type { ScraperConfig } from '@capella/types'

/**
 * One shared Chromium instance per worker process — launching per page would
 * dominate the runtime of a 1000-URL job.
 */
let browser: Browser | null = null
let context: BrowserContext | null = null

export async function getContext(config: ScraperConfig): Promise<BrowserContext> {
  if (context) return context

  browser = await chromium.launch({
    headless: true,
    args: ['--disable-dev-shm-usage', '--no-sandbox'],
  })

  context = await browser.newContext({
    userAgent: config.userAgent,
    viewport: { width: 1440, height: 900 },
    // Capella serves different markup to consent-gated visitors; ignoring HTTPS
    // errors keeps staging hosts with self-signed certs usable too.
    ignoreHTTPSErrors: true,
  })

  context.setDefaultTimeout(config.pageTimeoutMs)
  context.setDefaultNavigationTimeout(config.pageTimeoutMs)

  // We never need the pixels — only the DOM. Blocking media and fonts cuts
  // several seconds off each page and a lot of bandwidth against a live site.
  await context.route('**/*', (route) => {
    const type = route.request().resourceType()
    if (type === 'image' || type === 'media' || type === 'font') {
      return route.abort()
    }
    return route.continue()
  })

  return context
}

export async function closeBrowser(): Promise<void> {
  await context?.close().catch(() => undefined)
  await browser?.close().catch(() => undefined)
  context = null
  browser = null
}

/** Register once at worker startup so Chromium doesn't outlive the process. */
export function registerShutdownHooks(): void {
  const shutdown = (): void => {
    void closeBrowser()
  }
  process.once('SIGTERM', shutdown)
  process.once('SIGINT', shutdown)
}
