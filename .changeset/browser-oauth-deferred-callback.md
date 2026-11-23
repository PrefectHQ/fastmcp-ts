---
"@prefecthq/fastmcp-ts": minor
---

`BrowserOAuth` adds `mode: 'deferred'`, which opens no popup on its own: the connection or request fails with the new `AuthorizationRequiredError`, the app opens the popup with the error's `openPopup()` from a click, and `completeAuthorization(serverUrl)` exchanges the code for tokens before the app reconnects. This lets apps connect on page load. `handleOAuthCallback()` now relays the callback query string and also broadcasts it on a same-origin `BroadcastChannel`, so authorization completes when the provider's consent page sets `Cross-Origin-Opener-Policy` and severs `window.opener`. Each authorization request carries a random `state`, and `BrowserOAuth` ignores replies for any other request.
