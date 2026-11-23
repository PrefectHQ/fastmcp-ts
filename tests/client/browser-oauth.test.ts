// @vitest-environment jsdom
import { afterEach, describe, it, expect, vi } from 'vitest'
import { BrowserOAuth, OAuth, handleOAuthCallback, type PendingAuthorization } from 'fastmcp-ts/client'

const AUTHORIZATION_URL = 'https://auth.example/authorize?state=s1'

afterEach(() => {
  vi.restoreAllMocks()
})

function fakePopup() {
  return { closed: false, close: vi.fn() }
}

function postFromCallback(search: string, origin = 'https://app.example') {
  window.dispatchEvent(
    new MessageEvent('message', { origin, data: { type: 'fastmcp:oauth', search } }),
  )
}

describe('BrowserOAuth popup flow', () => {
  it('is an instanceof OAuth (so the client flow drives it)', () => {
    const o = new BrowserOAuth({ redirectUri: 'https://app.example/callback' })
    expect(o).toBeInstanceOf(OAuth)
  })

  it('uses the app redirectUri in metadata', () => {
    const o = new BrowserOAuth({ redirectUri: 'https://app.example/callback' })
    expect(o.redirectUrl).toBe('https://app.example/callback')
    expect(o.clientMetadata.redirect_uris).toEqual(['https://app.example/callback'])
  })

  it('opens a popup and resolves waitForCallback from the callback page', async () => {
    const o = new BrowserOAuth({ redirectUri: 'https://app.example/callback' })
    o._bind('https://srv.example')
    const popup = fakePopup()
    const openSpy = vi.spyOn(window, 'open').mockReturnValue(popup as unknown as Window)

    await o.redirectToAuthorization(new URL(AUTHORIZATION_URL))
    expect(openSpy).toHaveBeenCalledOnce()

    const wait = o.waitForCallback(5000)
    postFromCallback('?code=THE_CODE&state=s1')
    const params = await wait
    expect(params.get('code')).toBe('THE_CODE')
    expect(popup.close).toHaveBeenCalled()
  })

  it('carries the RFC 9207 iss parameter through from the callback page', async () => {
    const o = new BrowserOAuth({ redirectUri: 'https://app.example/callback' })
    o._bind('https://srv.example')
    vi.spyOn(window, 'open').mockReturnValue(fakePopup() as unknown as Window)
    await o.redirectToAuthorization(new URL(AUTHORIZATION_URL))

    const wait = o.waitForCallback(5000)
    postFromCallback(`?code=THE_CODE&state=s1&iss=${encodeURIComponent('https://auth.example')}`)
    const params = await wait
    expect(params.get('code')).toBe('THE_CODE')
    expect(params.get('iss')).toBe('https://auth.example')
  })

  it('ignores messages from an unexpected origin', async () => {
    const o = new BrowserOAuth({ redirectUri: 'https://app.example/callback' })
    o._bind('https://srv.example')
    vi.spyOn(window, 'open').mockReturnValue(fakePopup() as unknown as Window)
    await o.redirectToAuthorization(new URL(AUTHORIZATION_URL))
    const wait = o.waitForCallback(300)
    // Malicious/foreign origin — must be ignored, so the call times out.
    postFromCallback('?code=STOLEN&state=s1', 'https://evil.example')
    await expect(wait).rejects.toThrow(/timed out/)
  })

  it('rejects waitForCallback when the provider returns an error', async () => {
    const o = new BrowserOAuth({ redirectUri: 'https://app.example/callback' })
    o._bind('https://srv.example')
    vi.spyOn(window, 'open').mockReturnValue(fakePopup() as unknown as Window)
    await o.redirectToAuthorization(new URL(AUTHORIZATION_URL))
    const wait = o.waitForCallback(5000)
    postFromCallback('?error=access_denied&state=s1')
    await expect(wait).rejects.toThrow(/access_denied/)
  })

  it('throws when the popup is blocked', async () => {
    const o = new BrowserOAuth({ redirectUri: 'https://app.example/callback' })
    o._bind('https://srv.example')
    vi.spyOn(window, 'open').mockReturnValue(null)
    await expect(o.redirectToAuthorization(new URL(AUTHORIZATION_URL))).rejects.toThrow(/blocked/)
  })

  it('refuses an authorization URL without a state to match its callback against', async () => {
    const o = new BrowserOAuth({ redirectUri: 'https://app.example/callback' })
    const openSpy = vi.spyOn(window, 'open')
    await expect(
      o.redirectToAuthorization(new URL('https://auth.example/authorize')),
    ).rejects.toThrow(/no state parameter/)
    expect(openSpy).not.toHaveBeenCalled()
  })

  it.each(['javascript:alert(1)', 'data:text/html,<p>x</p>', 'file:///etc/passwd'])(
    'refuses to open a %s authorization URL',
    async (url) => {
      for (const mode of ['popup', 'redirect'] as const) {
        const o = new BrowserOAuth({ redirectUri: 'https://app.example/callback', mode })
        o._bind('https://srv.example')
        const openSpy = vi.spyOn(window, 'open')
        openSpy.mockClear()
        await expect(o.redirectToAuthorization(new URL(url))).rejects.toThrow(/only http: and https:/)
        expect(openSpy).not.toHaveBeenCalled()
        openSpy.mockRestore()
      }
    },
  )
})

describe('BrowserOAuth callback matching', () => {
  it('issues a fresh state for each authorization request', () => {
    const o = new BrowserOAuth({ redirectUri: 'https://app.example/callback' })
    const first = o.state()
    expect(first).toMatch(/^[0-9a-f-]{36}$/)
    expect(o.state()).not.toBe(first)
  })

  it("ignores a reply carrying another request's state", async () => {
    const o = new BrowserOAuth({ redirectUri: 'https://app.example/callback' })
    o._bind('https://srv.example')
    vi.spyOn(window, 'open').mockReturnValue(fakePopup() as unknown as Window)
    await o.redirectToAuthorization(new URL(AUTHORIZATION_URL))

    const wait = o.waitForCallback(5000)
    postFromCallback('?code=CODE_FOR_THEM&state=theirs')
    postFromCallback('?code=CODE_FOR_ME&state=s1')
    const params = await wait
    expect(params.get('code')).toBe('CODE_FOR_ME')
  })

  it('resolves from the BroadcastChannel when the opener link is gone', async () => {
    const o = new BrowserOAuth({ redirectUri: 'https://app.example/callback' })
    o._bind('https://srv.example')
    vi.spyOn(window, 'open').mockReturnValue(fakePopup() as unknown as Window)
    await o.redirectToAuthorization(new URL(AUTHORIZATION_URL))

    const wait = o.waitForCallback(5000)
    const channel = new BroadcastChannel('fastmcp:oauth')
    channel.postMessage({ type: 'fastmcp:oauth', search: '?code=THE_CODE&state=s1' })
    channel.close()

    const params = await wait
    expect(params.get('code')).toBe('THE_CODE')
  })

  it('handleOAuthCallback relays the callback query string on the BroadcastChannel', async () => {
    window.history.replaceState(null, '', '/callback?code=THE_CODE&state=s1')
    const close = vi.spyOn(window, 'close').mockImplementation(() => undefined)
    const channel = new BroadcastChannel('fastmcp:oauth')
    const received = new Promise<unknown>((resolve) =>
      channel.addEventListener('message', (e) => resolve(e.data), { once: true }),
    )

    handleOAuthCallback()

    await expect(received).resolves.toEqual({
      type: 'fastmcp:oauth',
      search: '?code=THE_CODE&state=s1',
    })
    expect(close).toHaveBeenCalledOnce()
    channel.close()
  })
})

describe('BrowserOAuth deferred mode', () => {
  async function requireAuthorization(): Promise<{ o: BrowserOAuth; authorization: PendingAuthorization }> {
    let authorization: PendingAuthorization | undefined
    const o = new BrowserOAuth({
      redirectUri: 'https://app.example/callback',
      mode: 'deferred',
      onAuthorizationRequired: (pending) => {
        authorization = pending
      },
    })
    o._bind('https://srv.example')
    await o.redirectToAuthorization(new URL(AUTHORIZATION_URL))
    if (!authorization) throw new Error('onAuthorizationRequired was not called')
    return { o, authorization }
  }

  it('hands the pending authorization to the app instead of opening a popup', async () => {
    const openSpy = vi.spyOn(window, 'open').mockReturnValue(fakePopup() as unknown as Window)

    const { o, authorization } = await requireAuthorization()
    expect(authorization.url.href).toBe(AUTHORIZATION_URL)
    expect(openSpy).not.toHaveBeenCalled()

    expect(authorization.openPopup()).toBe(true)
    expect(openSpy).toHaveBeenCalledWith(AUTHORIZATION_URL, 'fastmcp-oauth', expect.any(String))

    const wait = o.waitForCallback(5000)
    postFromCallback('?code=THE_CODE&state=s1')
    const params = await wait
    expect(params.get('code')).toBe('THE_CODE')
  })

  it('reports a blocked popup and lets the app try again', async () => {
    const openSpy = vi
      .spyOn(window, 'open')
      .mockReturnValueOnce(null)
      .mockReturnValueOnce(fakePopup() as unknown as Window)

    const { authorization } = await requireAuthorization()

    expect(authorization.openPopup()).toBe(false)
    expect(authorization.openPopup()).toBe(true)
    expect(openSpy).toHaveBeenCalledTimes(2)
  })
})

describe('BrowserOAuth redirect mode', () => {
  // Note: the actual tab navigation (window.location.assign) is a browser
  // primitive jsdom does not implement and cannot mock (location is locked
  // down), so it is exercised by the Playwright e2e rather than here. The
  // testable redirect-mode logic is resumeFromRedirect, covered below.

  it('resumeFromRedirect extracts the code from a returned URL', () => {
    const o = new BrowserOAuth({ redirectUri: 'https://app.example/callback', mode: 'redirect' })
    const params = o.resumeFromRedirect('https://app.example/callback?code=XYZ&state=s')
    expect(params?.get('code')).toBe('XYZ')
  })

  it('resumeFromRedirect carries the iss parameter through when present', () => {
    const o = new BrowserOAuth({ redirectUri: 'https://app.example/callback', mode: 'redirect' })
    const params = o.resumeFromRedirect(
      `https://app.example/callback?code=XYZ&iss=${encodeURIComponent('https://auth.example.com')}`,
    )
    expect(params?.get('iss')).toBe('https://auth.example.com')
  })

  it('resumeFromRedirect returns null when there is no code', () => {
    const o = new BrowserOAuth({ redirectUri: 'https://app.example/callback', mode: 'redirect' })
    expect(o.resumeFromRedirect('https://app.example/callback')).toBeNull()
  })

  it('resumeFromRedirect throws on an error param', () => {
    const o = new BrowserOAuth({ redirectUri: 'https://app.example/callback', mode: 'redirect' })
    expect(() => o.resumeFromRedirect('https://app.example/callback?error=access_denied')).toThrow(
      /access_denied/,
    )
  })
})
