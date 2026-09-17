import type { ScraperConfig, ScrapeOutcome } from '@capella/types'
import { scrapePage } from './scraper.js'

/**
 * Scrape a batch with bounded concurrency.
 *
 * Playwright pages are far heavier than a fetch, so concurrency stays at 5 by
 * default. Results come back in input order regardless of completion order.
 *
 * A rejected promise here would abort the whole batch, so `scrapePage` is
 * written never to throw — this function upholds the same contract.
 */
export async function scrapeBatch(
  urls: string[],
  config: ScraperConfig,
): Promise<ScrapeOutcome[]> {
  const results: ScrapeOutcome[] = new Array(urls.length)
  let cursor = 0

  const workerCount = Math.max(1, Math.min(config.concurrency, urls.length))

  const runWorker = async (): Promise<void> => {
    for (;;) {
      const index = cursor++
      if (index >= urls.length) return

      const url = urls[index]
      if (url === undefined) return

      try {
        results[index] = await scrapePage(url, config)
      } catch (error) {
        // Defensive: scrapePage is not supposed to throw, but one unexpected
        // rejection must not take the batch down with it.
        results[index] = {
          ok: false,
          failure: { url, error: error instanceof Error ? error.message : String(error) },
        }
      }

      if (config.politenessDelayMs > 0) {
        await delay(config.politenessDelayMs)
      }
    }
  }

  await Promise.all(Array.from({ length: workerCount }, () => runWorker()))

  return results
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
