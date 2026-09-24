import { ApiError, api } from './client'

/**
 * What the UI says when there is no API at the address it was given.
 *
 * This is the shape a static-host deployment takes when `VITE_API_ORIGIN` is
 * unset: the host answers a GET with the SPA's own index.html and a 200, and a
 * POST with 405 because it only allows GET and HEAD. Raw, those read as two
 * unrelated bugs — "non-JSON response (HTTP 200)" and "HTTP 405" — when they
 * are one missing backend.
 */

const realFetch = globalThis.fetch

function mockResponse(init: { status: number; body: string; contentType: string }): void {
  globalThis.fetch = (async () =>
    new Response(init.body, {
      status: init.status,
      headers: { 'content-type': init.contentType },
    })) as typeof fetch
}

afterEach(() => {
  globalThis.fetch = realFetch
})

describe('a static host with no API behind it', () => {
  it('names the missing backend when a GET returns the SPA shell', async () => {
    mockResponse({
      status: 200,
      contentType: 'text/html; charset=utf-8',
      body: '<!doctype html><html><body>app shell</body></html>',
    })

    await expect(api.get('/assets/stats')).rejects.toMatchObject({
      code: 'API_NOT_REACHABLE',
    })
  })

  it('names it for a 405 on a POST, which carries no body to inspect', async () => {
    mockResponse({ status: 405, contentType: 'text/plain', body: '' })

    await expect(api.post('/audit', { urls: 'https://www.capella.edu/' })).rejects.toMatchObject({
      code: 'API_NOT_REACHABLE',
    })
  })

  it('exposes it as a deployment problem, not a request problem', async () => {
    mockResponse({ status: 405, contentType: 'text/plain', body: '' })

    const error = await api.post('/audit').catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ApiError)
    expect((error as ApiError).isApiUnreachable).toBe(true)
    expect((error as ApiError).message).toMatch(/backend is not/i)
  })
})

describe('a real API that is merely unhappy', () => {
  it('still reports the server’s own error, not a deployment guess', async () => {
    mockResponse({
      status: 400,
      contentType: 'application/json',
      body: JSON.stringify({ error: { code: 'NO_URLS_PROVIDED', message: 'No valid URLs found.' } }),
    })

    const error = await api.post('/audit').catch((e: unknown) => e)
    expect((error as ApiError).code).toBe('NO_URLS_PROVIDED')
    expect((error as ApiError).isApiUnreachable).toBe(false)
  })

  it('does not mistake a genuine 500 with an HTML error page for a missing API… unless it is HTML', async () => {
    // Deliberate: an HTML 500 from a real API is indistinguishable from a
    // static host's shell, and pointing at deployment is the more useful guess.
    mockResponse({ status: 500, contentType: 'text/html', body: '<!doctype html><h1>oops</h1>' })
    const error = await api.get('/assets/stats').catch((e: unknown) => e)
    expect((error as ApiError).code).toBe('API_NOT_REACHABLE')
  })
})
