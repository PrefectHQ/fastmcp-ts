---
'@prefecthq/fastmcp-ts': minor
---

Add configurable CORS for the HTTP listener via `http.cors` — restrict origins (string, list, or predicate), enable credentialed requests, extend the allowed/exposed header lists, replace the methods list, set a preflight max-age, or disable CORS entirely with `cors: false`. The OAuth serve path now applies the same CORS handling as the plain path (it previously had none), and responses now expose `Mcp-Session-Id` by default so cross-origin browser clients can read their session id. Defaults are otherwise unchanged (`Access-Control-Allow-Origin: *`). Non-preflight responses no longer include `Access-Control-Allow-Methods`/`Access-Control-Allow-Headers`; browsers read those only from preflight answers.
