// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { BrowserOAuth, OAuth } from 'fastmcp-ts/client'

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

  it('opens a popup and resolves waitForCallback from a postMessage', async () => {
    const o = new BrowserOAuth({ redirectUri: 'https://app.example/callback' })
    o._bind('https://srv.example')
    const popup = { closed: false, close: vi.fn() }
    const openSpy = vi.spyOn(window, 'open').mockReturnValue(popup as unknown as Window)

    await o.redirectToAuthorization(new URL('https://auth.example/authorize?x=1'))
    expect(openSpy).toHaveBeenCalledOnce()

    const wait = o.waitForCallback(5000)
    window.dispatchEvent(
      new MessageEvent('message', {
        origin: 'https://app.example',
        data: { type: 'fastmcp:oauth', code: 'THE_CODE' },
      }),
    )
    expect(await wait).toBe('THE_CODE')
    expect(popup.close).toHaveBeenCalled()
  })

  it('ignores messages from an unexpected origin', async () => {
    const o = new BrowserOAuth({ redirectUri: 'https://app.example/callback' })
    o._bind('https://srv.example')
    vi.spyOn(window, 'open').mockReturnValue({ closed: false, close: vi.fn() } as unknown as Window)
    await o.redirectToAuthorization(new URL('https://auth.example/authorize'))
    const wait = o.waitForCallback(300)
    // Malicious/foreign origin — must be ignored, so the call times out.
    window.dispatchEvent(
      new MessageEvent('message', {
        origin: 'https://evil.example',
        data: { type: 'fastmcp:oauth', code: 'STOLEN' },
      }),
    )
    await expect(wait).rejects.toThrow(/timed out/)
  })

  it('rejects waitForCallback on an error message', async () => {
    const o = new BrowserOAuth({ redirectUri: 'https://app.example/callback' })
    o._bind('https://srv.example')
    vi.spyOn(window, 'open').mockReturnValue({ closed: false, close: vi.fn() } as unknown as Window)
    await o.redirectToAuthorization(new URL('https://auth.example/authorize'))
    const wait = o.waitForCallback(5000)
    window.dispatchEvent(
      new MessageEvent('message', {
        origin: 'https://app.example',
        data: { type: 'fastmcp:oauth', error: 'access_denied' },
      }),
    )
    await expect(wait).rejects.toThrow(/access_denied/)
  })

  it('throws when the popup is blocked', async () => {
    const o = new BrowserOAuth({ redirectUri: 'https://app.example/callback' })
    o._bind('https://srv.example')
    vi.spyOn(window, 'open').mockReturnValue(null)
    await expect(o.redirectToAuthorization(new URL('https://auth.example/authorize'))).rejects.toThrow(
      /blocked/,
    )
  })
})

describe('BrowserOAuth redirect mode', () => {
  // Note: the actual tab navigation (window.location.assign) is a browser
  // primitive jsdom does not implement and cannot mock (location is locked
  // down), so it is exercised by the Playwright e2e rather than here. The
  // testable redirect-mode logic is resumeFromRedirect, covered below.

  it('resumeFromRedirect extracts the code from a returned URL', () => {
    const o = new BrowserOAuth({ redirectUri: 'https://app.example/callback', mode: 'redirect' })
    expect(o.resumeFromRedirect('https://app.example/callback?code=XYZ&state=s')).toBe('XYZ')
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
