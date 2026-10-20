---
"@prefecthq/fastmcp-ts": minor
---

Servers that verify tokens from an external authorization server can now publish RFC 9728 protected resource metadata (#114). Wrap a token or request verifier with `remoteAuth({ verifier, authorizationServers, baseUrl })` and pass it to `auth`: the HTTP server serves the document at the path-scoped well-known URL (`/.well-known/oauth-protected-resource/mcp` for `/mcp`) and every 401 challenge names it in `resource_metadata`. The built-in `oauth` mode now serves its protected resource metadata at the same path-scoped URL and names it in its 401 challenges. The root URL `/.well-known/oauth-protected-resource` no longer serves it. `oauthProvider()` now answers an unknown or expired token with 401 `invalid_token` instead of 500.
