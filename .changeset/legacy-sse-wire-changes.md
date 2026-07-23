---
"@prefecthq/fastmcp-ts": major
---

Legacy SSE transport: wire-format changes.

The legacy HTTP+SSE transport changes what it sends on the wire (SEP-1699). Every result event on the legacy HTTP+SSE transport now carries an `id:` field. The server sends priming events when a stream opens. A `GET` request replays the events after the last acknowledged `id`, so a client resumes after a dropped connection. The server answers `400` when the requested anchor is no longer in the replay buffer. The buffer holds a bounded number of recent events per session.

Code that uses the transport through the FastMCP client needs no change. The client handles the new framing and the replay. Code that parses the raw SSE stream must account for the `id:` field, the priming events, and the `400` on an evicted anchor.
