---
"@prefecthq/fastmcp-ts": patch
---

Legacy-HTTP sampling, elicitation, and roots requests now ride the in-flight request's stream.

On a legacy sessionful HTTP connection, `ctx.sample()`, `ctx.elicit()`, and `ctx.listRoots()` raise a server-to-client request. Before this change, the server sent that request on the standalone server-to-client stream. A client opens that stream after `initialize`. The server dropped the request when the stream was not yet open. A client that called a sampling or elicitation tool as its first operation could then wait for its timeout.

FastMCP now tags each such request with the in-flight tool call's request id. The server sends the request on that tool call's own response stream, which the client already reads. This removes the startup hang window. The stdio and modern paths are unchanged.
