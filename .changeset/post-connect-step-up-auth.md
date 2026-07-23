---
"@prefecthq/fastmcp-ts": minor
---

Client auth: step-up authorization now runs after connect.

A server can raise a `401` after the client connects — for example, when a tool needs a scope that the first token does not carry. The client now answers this challenge with a step-up authorization request. With an interactive OAuth flow configured, the client can open a browser to complete the authorization. In 0.x the client failed fast on a post-connect `401` instead.

The client retries at most twice, and concurrent calls share one authorization request. A client that must stay non-interactive — a headless or automated client — must configure a non-interactive auth strategy, so a post-connect challenge does not try to open a browser.
