---
"@prefecthq/fastmcp-ts": patch
---

Fix: a modern stdio server no longer advertises `resources.subscribe`.

A server on stdio in the modern era advertised the `resources.subscribe` capability by mistake. The modern era carries resource change signals over the `subscriptions/listen` stream, not over `resources/subscribe`, so the advertisement was wrong. The server now reports the correct capabilities for the negotiated era. A modern client no longer sees a subscribe capability that the modern era does not use.
