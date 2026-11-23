import type { OAuthClientMetadata } from "@modelcontextprotocol/server";

// ---------------------------------------------------------------------------
// BrowserOAuth — OAuth authorization-code + PKCE flow for the browser.
//
// Extends the Node OAuth provider, reusing all of its PKCE / token / discovery
// logic (which is already browser-safe), and replaces only the redirect
// mechanism: instead of opening the system browser and listening on a localhost
// HTTP callback server, it opens a popup (immediately, or when the app asks in
// deferred mode) or navigates the tab, and receives the authorization callback
// from the callback page (popup and deferred) or the returned URL (redirect).
// Because it `instanceof OAuth`, the Client connect flow
// (connect → waitForCallback → finishAuth → reconnect) drives it unchanged.
// ---------------------------------------------------------------------------
import { OAuth, assertHttpAuthorizationUrl, type OAuthOptions } from './auth.js'

/** Message type sent by {@link handleOAuthCallback} back to the app. */
const MESSAGE_TYPE = 'fastmcp:oauth'
/** Same-origin BroadcastChannel {@link handleOAuthCallback} also reports on. */
const CHANNEL_NAME = 'fastmcp:oauth'

/** The callback page relays its query string untouched. */
type CallbackReply = { type: typeof MESSAGE_TYPE; search: string }

function isCallbackReply(data: unknown): data is CallbackReply {
  return (
    typeof data === 'object' &&
    data !== null &&
    'type' in data &&
    data.type === MESSAGE_TYPE &&
    'search' in data &&
    typeof data.search === 'string'
  )
}

/** An authorization waiting for the user, handed to the app in deferred mode. */
export interface PendingAuthorization {
  url: URL
  /**
   * Opens the authorization in a popup. Call it from a user gesture such as a
   * click, or the browser blocks the popup. Calling it again reopens the same
   * authorization. Returns `false` when the popup was blocked.
   */
  openPopup: () => boolean
}

export type BrowserOAuthOptions = Omit<OAuthOptions, 'callbackPort' | 'onRedirect'> & {
  /**
   * Redirect URI registered with the provider. Must serve a page that calls
   * {@link handleOAuthCallback} (popup and deferred modes) or is your app route
   * that reads the returned `?code=` (redirect mode).
   */
  redirectUri: string
  /** `window.open` features string for popup and deferred modes. */
  popupFeatures?: string
} & (
    | {
        /**
         * 'popup' (default) opens the authorization URL in a popup window as
         * soon as authorization is needed. 'redirect' navigates the whole tab;
         * resume with {@link BrowserOAuth.resumeFromRedirect} on return.
         */
        mode?: 'popup' | 'redirect'
      }
    | {
        /**
         * 'deferred' opens nothing on its own. It hands the pending
         * authorization to `onAuthorizationRequired`, and the app opens the
         * popup from a user gesture.
         */
        mode: 'deferred'
        /**
         * Called when the user must authorize. Show a control whose click
         * handler calls `authorization.openPopup()`.
         */
        onAuthorizationRequired: (authorization: PendingAuthorization) => void
      }
  )

export class BrowserOAuth extends OAuth {
  private readonly _options: BrowserOAuthOptions
  private _popup: Window | null = null
  private _stopListening: (() => void) | null = null

  constructor(options: BrowserOAuthOptions) {
    super(options)
    this._options = options
  }

  get redirectUrl(): string {
    return this._options.redirectUri
  }

  get clientMetadata(): OAuthClientMetadata {
    return { ...super.clientMetadata, redirect_uris: [this._options.redirectUri] }
  }

  /**
   * A fresh `state` for each authorization request. The callback echoes it
   * back, which is how a reply is matched to this provider's request when every
   * tab on the origin hears it over the BroadcastChannel.
   */
  state(): string {
    return crypto.randomUUID()
  }

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    assertHttpAuthorizationUrl(authorizationUrl)
    if (this._options.mode === 'redirect') {
      // Navigation destroys this JS context; the app resumes via
      // resumeFromRedirect() on the return load.
      window.location.assign(authorizationUrl.toString())
      return
    }

    const state = authorizationUrl.searchParams.get('state')
    if (!state) {
      throw new Error('The authorization URL has no state parameter to match its callback against.')
    }
    this._teardown()
    this._stopListening = this._listenForCallback(state)
    // Arm the callback promise before opening so a fast provider can't race us.
    this._armCallbackPromise()

    const openPopup = () => {
      this._popup = window.open(authorizationUrl.toString(), 'fastmcp-oauth', this._options.popupFeatures ?? 'width=600,height=720')
      return this._popup !== null
    }
    if (this._options.mode === 'deferred') {
      this._options.onAuthorizationRequired({ url: authorizationUrl, openPopup })
      return
    }
    if (!openPopup()) {
      this._teardown()
      throw new Error(
        'Failed to open OAuth popup — it was likely blocked. Trigger connect from a user gesture, or use mode: "deferred" or mode: "redirect".',
      )
    }
  }

  async waitForCallback(timeoutMs = 5 * 60 * 1000): Promise<URLSearchParams> {
    try {
      return await this._awaitCallback(timeoutMs)
    } finally {
      this._teardown()
    }
  }

  /**
   * Redirect-mode resume: parse the authorization callback params from a
   * returned URL (defaults to the current location). Returns the full
   * `URLSearchParams` (including `code` and, when present, `iss`) — pass
   * directly to `finishAuth()` — or `null` if there is no `code`. Throws if
   * the provider returned an error.
   */
  resumeFromRedirect(href: string = window.location.href): URLSearchParams | null {
    const params = new URL(href).searchParams
    const error = params.get('error_description') ?? params.get('error')
    if (error) throw new Error(`OAuth authorization denied: ${error}`)
    return params.has('code') ? params : null
  }

  /** Listens on both callback routes until the returned function is called. */
  private _listenForCallback(expectedState: string): () => void {
    const receive = (data: unknown) => {
      if (!isCallbackReply(data)) return
      const params = new URLSearchParams(data.search)
      if (params.get('state') !== expectedState) return
      const error = params.get('error_description') ?? params.get('error')
      if (error) {
        this._rejectCallback(new Error(`OAuth authorization denied: ${error}`))
      } else if (params.has('code')) {
        this._resolveCallback(params)
      }
    }

    const expectedOrigin = new URL(this._options.redirectUri).origin
    const onWindowMessage = (e: MessageEvent) => {
      if (e.origin === expectedOrigin) receive(e.data)
    }
    const channel = new BroadcastChannel(CHANNEL_NAME)
    channel.addEventListener('message', (e: MessageEvent) => receive(e.data))
    window.addEventListener('message', onWindowMessage)
    return () => {
      window.removeEventListener('message', onWindowMessage)
      channel.close()
    }
  }

  private _teardown(): void {
    this._stopListening?.()
    this._stopListening = null
    try {
      this._popup?.close()
    } catch {
      // Cross-origin popups may throw on close — ignore.
    }
    this._popup = null
  }
}

/**
 * Call from the redirect_uri page (popup and deferred modes) to deliver the
 * authorization callback back to the app and close the popup.
 */
export function handleOAuthCallback(opts: { targetOrigin?: string } = {}): void {
  const reply: CallbackReply = { type: MESSAGE_TYPE, search: window.location.search }
  window.opener?.postMessage(reply, opts.targetOrigin ?? window.location.origin)
  // A provider page served with Cross-Origin-Opener-Policy severs
  // window.opener for the rest of the popup's life, so the reply also goes out
  // on a same-origin channel the app listens on.
  const channel = new BroadcastChannel(CHANNEL_NAME)
  channel.postMessage(reply)
  channel.close()
  window.close()
}
