---
"@prefecthq/fastmcp-ts": patch
---

Fix modern-era (2026-07-28) resource subscriptions (#88). FastMCP servers now advertise the `resources.subscribe` capability on modern connections, so `subscriptions/listen` `resourceSubscriptions` filters are honored instead of being silently pruned, and `notifyResourceUpdated()` reaches modern subscribers on both HTTP and stdio (stdio delivery is routed through the SDK's listen router). Stateless legacy HTTP still withdraws the capability. `Client.subscribeResource()` on a modern connection now rejects with a clear error when the server does not honor the subscription, instead of registering a handler that can never fire.
