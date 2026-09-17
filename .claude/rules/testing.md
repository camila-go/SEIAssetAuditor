# Testing Rules

Loaded when writing or modifying test files.

## Framework

- Unit + integration: Jest + `@testing-library/react` (UI), Supertest (API)
- E2E: Playwright
- Test files co-located with source: `Component.test.tsx`, `service.test.ts`
- E2E tests in `apps/ui/e2e/`

## What to Test

Always write tests for:
- Scraper asset extraction (given HTML fixture → expected asset paths)
- Testimonial extraction and deduplication logic
- pHash comparison (known similar → match, known different → no match)
- Query Builder URL construction — verify params are correct, especially `p.limit` always set
- API response shape for every route handler
- AuditJob state transitions (queued → running → complete)
- One bad URL in a batch must not fail the whole job

## AEM & Network Mocking

Never launch a real Playwright browser or make real HTTP requests in tests.

```typescript
// Mock Playwright browser for scraper tests
jest.mock('playwright', () => ({
  chromium: {
    launch: jest.fn().mockResolvedValue({
      newPage: jest.fn().mockResolvedValue({
        goto: jest.fn().mockResolvedValue(null),
        evaluate: jest.fn().mockResolvedValue([]),
        close: jest.fn().mockResolvedValue(null)
      }),
      close: jest.fn().mockResolvedValue(null)
    })
  }
}))

// For specific scraper unit tests — mock page.evaluate with fixture data
const mockEvaluate = jest.fn()
  .mockResolvedValueOnce(['/content/dam/capella/images/hero.jpg'])  // assets call
  .mockResolvedValueOnce([{ quote_text: 'Great program', raw_html: '<div>...</div>', source_type: 'structured_component' }])  // testimonials call
```

Use HTML fixture files in `__fixtures__/` to test extraction logic in isolation — pass fixture HTML to a standalone extraction function rather than going through full Playwright.

## Test Database

Integration tests run against a separate test DB: `DATABASE_URL` from `.env.test`.
Run `npm run db:migrate -- --env test` to set it up.
Reset relevant tables in `beforeEach` using Prisma `deleteMany`.

## Playwright E2E

- Tests in `apps/ui/e2e/`
- Run against local dev server — `npm run dev` must be running
- Cover three core flows: bulk audit (paste + CSV + sitemap), asset lookup, testimonial search
- Use `data-testid` selectors only — never CSS class selectors
- Test that audit job polling works — mock the status endpoint to simulate progress

## Transcription Testing

Never call real Whisper API or run real ffmpeg in tests.

```typescript
// Mock ffmpeg execution
jest.mock('execa', () => ({
  execa: jest.fn().mockResolvedValue({ exitCode: 0 })
}))

// Mock Whisper API response
jest.mock('node-fetch', () => jest.fn().mockResolvedValue({
  ok: true,
  json: async () => ({
    text: 'Welcome to Capella University.',
    duration: 62.4,
    words: [
      { word: 'Welcome', start: 0.0, end: 0.5 },
      { word: 'to', start: 0.5, end: 0.7 },
      // ...
    ]
  })
}))
```

Always test:
- VTT generation: given Whisper word array → valid WebVTT string starting with 'WEBVTT'
- Temp file deletion: verify `fs.unlink` called in both success and error paths
- Transcription failure does not block approval workflow — VideoSubmission status still advances
- Audio chunking logic for files that would exceed 25MB Whisper limit
- Chapter detection returns valid JSON — test malformed LLM response handling
