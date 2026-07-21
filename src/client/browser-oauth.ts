import type { OAuthClientMetadata } from "@modelcontextprotocol/server";

// ---------------------------------------------------------------------------
// BrowserOAuth — OAuth authorization-code + PKCE flow for the browser.
//
// Extends the Node OAuth provider, reusing all of its PKCE / token / discovery
// logic (which is already browser-safe), and replaces only the redirect
// mechanism: instead of opening the system browser and listening on a localhost
// HTTP callback server, it opens a popup (default) or navigates the tab, and
// receives the authorization code via postMessage (popup) or the returned URL
// (redirect). Because it `instanceof OAuth`, the Client connect flow
// (connect → waitForCallback → finishAuth → reconnect) drives it unchanged.
// ---------------------------------------------------------------------------
import { OAuth, type OAuthOptions } from './auth.js'

/** postMessage payload sent by {@link handleOAuthCallback} back to the opener. */
const MESSAGE_TYPE = 'fastmcp:oauth'

export interface BrowserOAuthOptions
  extends Omit<OAuthOptions, 'callbackPort' | 'onRedirect'> {
  /**
   * Redirect URI registered with the provider. Must serve a page that calls
   * {@link handleOAuthCallback} (popup mode) or is your app route that reads the
   * returned `?code=` (redirect mode).
   */
  redirectUri: string
  /**
   * 'popup' (default) opens the authorization URL in a popup window and listens
   * for a postMessage from the callback page. 'redirect' navigates the whole
   * tab; resume with {@link BrowserOAuth.resumeFromRedirect} on return.
   */
  mode?: 'popup' | 'redirect'
  /** `window.open` features string for popup mode. */
  popupFeatures?: string
}

export class BrowserOAuth extends OAuth {
  private readonly _redirectUri: string
  private readonly _mode: 'popup' | 'redirect'
  private readonly _popupFeatures: string
  private _popup: Window | null = null
  private _messageHandler: ((e: MessageEvent) => void) | null = null

  constructor(options: BrowserOAuthOptions) {
    super(options)
    this._redirectUri = options.redirectUri
    this._mode = options.mode ?? 'popup'
    this._popupFeatures = options.popupFeatures ?? 'width=600,height=720'
  }

  get redirectUrl(): string {
    return this._redirectUri
  }

  get clientMetadata(): OAuthClientMetadata {
    return { ...super.clientMetadata, redirect_uris: [this._redirectUri] }
  }

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    if (this._mode === 'redirect') {
      // Navigation destroys this JS context; the app resumes via
      // resumeFromRedirect() on the return load.
      window.location.assign(authorizationUrl.toString())
      return
    }

    const expectedOrigin = new URL(this._redirectUri).origin
    this._messageHandler = (e: MessageEvent) => {
      if (e.origin !== expectedOrigin) return
      const data = e.data as { type?: string; code?: string; error?: string }
      if (data?.type !== MESSAGE_TYPE) return
      if (data.error) this._rejectCallback(new Error(`OAuth authorization denied: ${data.error}`))
      else if (data.code) this._resolveCallback(data.code)
    }
    window.addEventListener('message', this._messageHandler)
    // Arm the callback promise before opening so a fast provider can't race us.
    this._armCallbackPromise()
    this._popup = window.open(authorizationUrl.toString(), 'fastmcp-oauth', this._popupFeatures)
    if (!this._popup) {
      this._teardown()
      throw new Error(
        'Failed to open OAuth popup — it was likely blocked. Trigger connect from a user gesture or use mode: "redirect".',
      )
    }
  }

  async waitForCallback(timeoutMs = 5 * 60 * 1000): Promise<string> {
    try {
      return await this._awaitCallback(timeoutMs)
    } finally {
      this._teardown()
    }
  }

  /**
   * Redirect-mode resume: parse the authorization code from a returned URL
   * (defaults to the current location). Returns the code, or null if absent.
   * Throws if the provider returned an error.
   */
  resumeFromRedirect(href: string = window.location.href): string | null {
    const params = new URL(href).searchParams
    const error = params.get('error_description') ?? params.get('error')
    if (error) throw new Error(`OAuth authorization denied: ${error}`)
    return params.get('code')
  }

  private _teardown(): void {
    if (this._messageHandler) window.removeEventListener('message', this._messageHandler)
    this._messageHandler = null
    try {
      this._popup?.close()
    } catch {
      // Cross-origin popups may throw on close — ignore.
    }
    this._popup = null
  }
}

/**
 * Call from the redirect_uri page (popup mode) to deliver the authorization
 * code back to the opener window and close the popup.
 */
export function handleOAuthCallback(opts: { targetOrigin?: string } = {}): void {
  const params = new URLSearchParams(window.location.search)
  const code = params.get('code') ?? undefined
  const error = params.get('error_description') ?? params.get('error') ?? undefined
  const target = opts.targetOrigin ?? window.location.origin
  window.opener?.postMessage({ type: MESSAGE_TYPE, code, error }, target)
  window.close()
}
