---
"@prefecthq/fastmcp-ts": major
---

`ClientCredentialsOptions` is now a discriminated union.

The `ClientCredentials` options changed from a single interface to a discriminated union with two members. One member takes a `clientSecret`, with an optional `authMethod` of `client_secret_post` (the default, unchanged) or `client_secret_basic`. The other member takes a `privateKey` and an `algorithm` for `private_key_jwt` (RFC 7523), and it requires an `audience`. The two members are mutually exclusive at compile time.

This is a breaking type change. Code that added fields to the old interface through declaration merging no longer compiles. Build the options as one of the two union members instead. Existing `clientSecret` configurations keep working, because the shared-secret member matches the old shape.
