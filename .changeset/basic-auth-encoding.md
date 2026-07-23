---
"@prefecthq/fastmcp-ts": patch
---

`client_secret_basic`: credentials use RFC 6749 §2.3.1 encoding.

The `client_secret_basic` method percent-encodes the client id and the client secret before it builds the HTTP Basic `Authorization` header, as RFC 6749 §2.3.1 requires. A space becomes `%20`. Many clients in the ecosystem instead Base64-encode the raw values. The two agree for a secret that holds only unreserved characters. They differ for a secret that holds reserved or special characters, sent to an authorization server that does not form-decode the header.

If your secret holds special characters and the authorization server rejects the request, confirm that the server decodes the Basic header per RFC 6749 §2.3.1.
