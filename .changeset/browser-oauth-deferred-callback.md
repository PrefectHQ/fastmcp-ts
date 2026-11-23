---
"@prefecthq/fastmcp-ts": minor
---

`BrowserOAuth` adds `mode: 'deferred'`, which opens no popup on its own: it hands a `PendingAuthorization` to the required `onAuthorizationRequired` option, and the app opens the popup with its `openPopup()` from a click, so apps can connect on page load. `handleOAuthCallback()` now relays the callback query string and also broadcasts it on a same-origin `BroadcastChannel`, so authorization completes when the provider's consent page sets `Cross-Origin-Opener-Policy` and severs `window.opener`. Each authorization request carries a random `state`, and `BrowserOAuth` ignores replies for any other request. `BrowserOAuthOptions` is now a type alias rather than an interface.
