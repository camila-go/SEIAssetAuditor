import { expect, test, type Page } from '@playwright/test'

/**
 * E2E covering the three core flows from the testing rules. Selectors are
 * `data-testid` only — never CSS classes.
 *
 * Requires `npm run dev` to be running.
 */

test.describe('bulk audit', () => {
  test('pasting URLs creates a job and navigates to its live view', async ({ page }) => {
    // Stub the API so the test never scrapes the real capella.edu.
    await page.route('**/api/v1/audit', async (route) => {
      if (route.request().method() !== 'POST') return route.continue()
      await route.fulfill({
        status: 202,
        contentType: 'application/json',
        body: JSON.stringify({ data: { jobId: 'job-123', status: 'queued', totalUrls: 2 } }),
      })
    })

    await stubJobProgress(page)

    await page.goto('/audit')
    await page
      .getByTestId('audit-urls-input')
      .fill('https://www.capella.edu/a/\nhttps://www.capella.edu/b/')
    await page.getByTestId('audit-submit').click()

    await expect(page).toHaveURL(/\/audit\/job-123/)
    await expect(page.getByRole('progressbar')).toBeVisible()
  })

  test('a CSV upload is accepted', async ({ page }) => {
    await page.route('**/api/v1/audit', async (route) => {
      if (route.request().method() !== 'POST') return route.continue()
      await route.fulfill({
        status: 202,
        contentType: 'application/json',
        body: JSON.stringify({ data: { jobId: 'job-csv', status: 'queued', totalUrls: 1 } }),
      })
    })

    await stubJobProgress(page, 'job-csv')

    await page.goto('/audit')
    await page.getByRole('tab', { name: 'Upload CSV / TXT' }).click()
    await page.getByTestId('audit-csv-input').setInputFiles({
      name: 'urls.csv',
      mimeType: 'text/csv',
      buffer: Buffer.from('url\nhttps://www.capella.edu/a/\n'),
    })
    await page.getByTestId('audit-submit').click()

    await expect(page).toHaveURL(/\/audit\/job-csv/)
  })

  test('a sitemap URL is accepted', async ({ page }) => {
    await page.route('**/api/v1/audit', async (route) => {
      if (route.request().method() !== 'POST') return route.continue()
      const body = route.request().postDataJSON() as { sitemapUrl?: string }
      expect(body.sitemapUrl).toBe('https://www.capella.edu/sitemap.xml')
      await route.fulfill({
        status: 202,
        contentType: 'application/json',
        body: JSON.stringify({ data: { jobId: 'job-map', status: 'queued', totalUrls: 500 } }),
      })
    })

    await stubJobProgress(page, 'job-map')

    await page.goto('/audit')
    await page.getByRole('tab', { name: 'Sitemap URL' }).click()
    await page.getByTestId('audit-sitemap-input').fill('https://www.capella.edu/sitemap.xml')
    await page.getByTestId('audit-submit').click()

    await expect(page).toHaveURL(/\/audit\/job-map/)
  })

  test('polling advances the progress bar while the job runs', async ({ page }) => {
    let poll = 0

    await page.route('**/api/v1/audit/job-poll/status', async (route) => {
      poll += 1
      const completed = Math.min(poll * 25, 100)
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          data: {
            jobId: 'job-poll',
            status: completed >= 100 ? 'complete' : 'running',
            totalUrls: 100,
            completedUrls: completed,
            failedUrls: 0,
            percentComplete: completed,
            estimatedMinutesRemaining: completed >= 100 ? 0 : 5,
            startedAt: new Date().toISOString(),
            completedAt: null,
            errorMessage: null,
          },
        }),
      })
    })

    await page.route('**/api/v1/audit/job-poll/results*', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ data: [], meta: { page: 1, limit: 50, total: 0 } }),
      }),
    )

    await page.goto('/audit/job-poll')

    await expect(page.getByText('25 of 100 URLs processed')).toBeVisible()
    // The UI polls every 3s; the stub advances 25% each time.
    await expect(page.getByText(/of 100 URLs processed/)).toContainText('50', { timeout: 10_000 })
  })
})

test.describe('asset lookup', () => {
  test('a DAM path returns the pages it appears on', async ({ page }) => {
    await page.route('**/api/v1/lookup*', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          data: {
            id: 'asset-1',
            aemPath: '/content/dam/capella/images/hero.jpg',
            filename: 'hero.jpg',
            assetType: 'image',
            publicUrl: 'https://www.capella.edu/content/dam/capella/images/hero.jpg',
            width: null,
            height: null,
            fileSize: null,
            tags: [],
            lastSeenAt: null,
            phash: null,
            isIndexed: true,
            deletedAt: null,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            referenceCount: 1,
            pages: [
              {
                pageId: 'page-1',
                url: 'https://www.capella.edu/about/',
                title: 'About Capella',
                liveStatus: 'published',
                lastCrawledAt: null,
                discoveredAt: new Date().toISOString(),
              },
            ],
          },
        }),
      }),
    )

    await page.goto('/lookup')
    await page.getByTestId('lookup-input').fill('/content/dam/capella/images/hero.jpg')
    await page.getByRole('button', { name: 'Look up' }).click()

    await expect(page.getByText('About Capella')).toBeVisible()
    await expect(page.getByText('Published')).toBeVisible()
  })
})

test.describe('testimonial search', () => {
  test('searching filters the list and highlights the match', async ({ page }) => {
    await page.route('**/api/v1/testimonials*', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          data: [
            {
              id: 'testimonial-1',
              quoteText: 'The flexibility of this program let me keep working full time.',
              studentName: 'Marcus Webb',
              program: 'Master of Science in Nursing',
              degreeLevel: 'masters',
              sourceType: 'structured_component',
              needsReview: false,
              isActive: true,
              firstSeenAt: new Date().toISOString(),
              lastSeenAt: new Date().toISOString(),
              daysSinceLastSeen: 3,
              referenceCount: 2,
            },
          ],
          meta: { page: 1, limit: 25, total: 1 },
        }),
      }),
    )

    await page.goto('/testimonials')
    await page.getByTestId('testimonial-search').fill('flexibility')

    await expect(page.getByTestId('testimonial-results')).toContainText('Marcus Webb')
    await expect(page.locator('mark').first()).toHaveText(/flexibility/i)
  })
})

async function stubJobProgress(page: Page, jobId = 'job-123'): Promise<void> {
  await page.route(`**/api/v1/audit/${jobId}/status`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        data: {
          jobId,
          status: 'running',
          totalUrls: 2,
          completedUrls: 0,
          failedUrls: 0,
          percentComplete: 0,
          estimatedMinutesRemaining: 1,
          startedAt: new Date().toISOString(),
          completedAt: null,
          errorMessage: null,
        },
      }),
    }),
  )

  await page.route(`**/api/v1/audit/${jobId}/results*`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: [], meta: { page: 1, limit: 50, total: 0 } }),
    }),
  )
}
