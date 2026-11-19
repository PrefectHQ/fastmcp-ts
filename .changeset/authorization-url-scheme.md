---
"@prefecthq/fastmcp-ts": patch
---

`OAuth` and `BrowserOAuth` now throw from `redirectToAuthorization` when the authorization URL's scheme is not `http:` or `https:`, before they start the callback server or open a browser, popup, or tab.
