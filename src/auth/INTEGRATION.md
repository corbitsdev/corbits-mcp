# CL-11477 authorization integration

## Supported seams

- `McpAuthPolicy` authenticates a host identity and authorizes explicit resource/action operations. `validateMcpIdentity` copies only tenant, principal, scopes and the host-assigned authorization-context partition. Public mode belongs to the server configuration, not this policy.
- `createMcpResourceServerAuth` composes an injected **cryptographic verifier or introspector**, exact issuer/audience/expiry checks, host authorization and optional operation scope requirements. The verifier must enforce algorithm/key trust, revocation and token type. Merely decoding a JWT is not sufficient. Mount `metadataResponse()` at the advertised metadata URL and use `challenge()` for 401/403 responses. Never forward this inbound bearer upstream.
- Retain `McpError.wwwAuthenticate` from the actual outbound 401/403 and pass it to `discoverMcpLoginEntry`. Challenge metadata wins; otherwise discovery tries path then root PRM. AS lookup tries OAuth insertion, OIDC insertion, then OIDC appending. Invalid successful metadata fails closed rather than trying to conceal an issuer mismatch with another endpoint.
- `prepareMcpClient` reuses issuer-bound stored pre-registration/DCR or portable CIMD, then performs real public-client DCR only if needed. The host must actually publish the CIMD JSON at the exact client ID URL and register exact callback URIs. The client does not pretend that creating a JSON object publishes it.
- `createMcpAuthorizationSession` uses installed oauth-core's public PKCE/state/authorize/code-exchange functions. Its one-use callback consumes complete URLSearchParams, validates state and issuer before exchange, and gives secrets only to an explicit host `persist(binding,tokens)` callback. That callback must encrypt storage, verify tenant/principal credential-creation authority, and persist issuer/resource/client/provenance atomically. The session does not grant credentials, mount routes, open a browser, or return tokens to MCP/model context. Access-token-only responses are supported without inventing a refresh token.
- `refreshMcpOAuthTokens` binds refresh to the recorded issuer/resource/client and carries rotated or retained refresh material. The host selects storage under its own tenant/principal authority; do not accept a caller-supplied binding as proof of ownership.
- `createMcpCallbackAdapter` implements oauth-core's injectable CallbackServer plus a Fetch receiver. The host binds **exactly** the registered callback URI before handing it to `startOAuthLogin`, and stops that listener through `closeListener`. This is an explicit listener integration contract, not an automatically mounted network server. It checks present `iss` even when advertisement is absent.
- `mcpStepUpScopes` computes a requested scope union from an insufficient-scope challenge. The host must bound retries, get user consent and start a fresh session; no automatic operation replay or permission widening occurs here.
- All OAuth endpoints require HTTPS, including internal and loopback AS endpoints. Only callback redirects and MCP endpoints permit loopback HTTP. Injected fetch is a trusted host networking boundary: apply deployment egress/DNS/address controls to prevent SSRF. URL validation alone cannot guarantee DNS routing safety.
- Hub discovery retains tenant-qualified credential lookup and origin pinning. A stored `oauthResource` is additionally bound exactly; origin allowances cannot override it. Peer JSON-RPC errors are untrusted and cannot be exposed through hub responses or onError. Existing legacy credentials without recorded resource provenance retain origin-only checks; migrate their host metadata before claiming resource-level isolation.

## Security migration

Issuer strings now compare exactly, including slash, case and port spelling. CIMD rejects literal and encoded dot segments, userinfo and fragments. OAuth metadata, registration and guarded token requests refuse redirects. Security-critical extra authorization parameters cannot replace state, PKCE, client, redirect, response type or scopes. The resource parameter is set on OAuthClientConfig itself, not only authorize extras. Discovery requires PRM by default; the old direct-AS fallback requires `allowLegacyAuthorizationServerFallback: true` and is not modern MCP conformance. Callback error text and upstream hub errors are sanitized rather than echoed. URL query access tokens are rejected.

## Installed dependency audit and companion issue briefs

Baseline inspected: `@corbits/oauth-core` 0.3.0 and `@corbits/credential-http` 0.1.0, installed declarations and runtime JS. No external repository or node_modules edits.

### oauth-core: token-only grant storage

Evidence: `dist/tokens.d.ts` requires `BaseTokens.refresh`; `dist/client.js` `baseTokensFromResponse` throws `OAuthMissingRefreshTokenError` if no refresh exists. `dist/hub/credentials.js` `writeOAuthTokens` and `persistOAuthCredential` unconditionally encrypt `tokens.refresh`. Valid access-token-only responses therefore cannot use stock profile/hub persistence. Requested upstream change: optional refresh through token/profile/storage contracts; absent refresh means reauthorization on expiry, not a fabricated token. Regression: code exchange with only access_token/token_type persists an access credential without a refresh secret; refresh scheduler skips it. Local MCP sessions support this via a separate honest host storage contract; stock persistence remains blocked.

### oauth-core: safe token transport and protected authorize parameters

Evidence: `dist/client.js` `postToken` omits redirect policy; non-2xx errors embed the raw response body; `buildAuthorizeUrl` applies extra parameters after state/PKCE and always sets scope, even empty. Requested upstream change: refuse credential-bearing redirects, sanitize public error messages while retaining bounded structured internal error codes, reject reserved authorize overrides, omit absent scope. Regression: 307 cannot forward code/verifier/refresh, reflected token text does not appear in public errors, extra state/PKCE cannot overwrite generated values. Local guarded MCP sessions use `secureOAuthFetch`, sanitize exchange/refresh errors, reject reserved extras, and omit empty scope. Direct stock helpers remain unchanged.

### oauth-core: stock hub discovery/registration/callback parity

Evidence: `dist/hub/mount.js` imports its own discovery implementation, requires registration_endpoint and always calls registerMcpClient. It passes expectedIssuer to callbacks **only when** authorization_response_iss_parameter_supported is true. `dist/hub/route-callback.js` compares iss only when expectedIssuer exists, so a present wrong iss can pass when metadata omits the flag. Stock provider login uses the code-only loopback callback. Requested upstream change: compose the public guarded discovery/registration/session seams or equivalent fixes; always record issuer and compare any present iss; preserve duplicate callback parameter detection. Tests: CIMD-only server, pre-registered issuer isolation, wrong present iss with absent/false advertisement. The local Fetch callback adapter and session cover these cases; stock provider/hub login is not claimed compliant.

### oauth-core: resource propagation audit correction

**Not an upstream blocker:** `OAuthClientConfig.resource` exists; installed exchangeCode and refreshTokenRequest send it. `dist/hub/refresh.js` registeredClientRefresh reads `oauthResource` and forwards resource. The defect was this package's config builder, now fixed and tested against the installed helpers. Host persistence must retain oauthResource and issuer; the stock metadata keys do not themselves provide full issuer/principal provenance.

### credential-http: RequestInit and transport policy

Evidence: `dist/origin-pinned-fetch.js` Request branch calls `new Request(input,{headers,redirect:"manual"})` and ignores init (including abort signal, method/body/header overrides); URL branch spreads init. It does correctly pin origins, validate credential header values, and force manual redirects. Origin/extraOrigins parsing uses new URL without restricting insecure schemes, so a trusted host can configure non-loopback HTTP credential destinations. Requested upstream change: preserve standard Request+init semantics while reapplying protected headers/redirect policy; reject insecure credential destinations except an explicit loopback development policy. Tests: Request+AbortSignal cancellation, init body/method handling, HTTP non-loopback rejection and no redirected bearer. Local hub endpoint/extra-origin validation uses parseMcpEndpoint and refuses redirect responses. Standalone external provider handles still require upstream correction/host policy.

## Verification limits

Synthetic complete challenge → PRM → OIDC → DCR → PKCE callback → token-only persistence → authenticated authorized request is covered, plus pre-registration/CIMD selection and refresh rotation. Host production DB transactions, live OAuth services, cryptographic verifiers/introspection, deployed callback listeners, browser consent, and distributed login durability are not verified here. Login sessions are in-process and expire; a restart requires a fresh login. These results are role- and integration-specific, not product-wide or stock-dependency compliance certification.

Normative revision: MCP 2026-07-28 basic/authorization and linked authorization-server-discovery, client-registration, security-considerations; RFC 9728, 8414, 9207 and 8707 binding rules. Tests live beside the owned auth/hub modules.

## Review follow-up: callback lifecycle and DCR application type

A callback with valid state and issuer consumes the one-use authorization session before its code or terminal error is processed. An authenticated denial cannot subsequently be replayed as a successful code. Wrong-state, missing-required-issuer, duplicate-issuer, and wrong-issuer attempts leave the legitimate session pending; the Fetch callback adapter uses the same provenance check and lifecycle.

`prepareMcpClient` accepts `applicationType: "web" | "native"` and forwards it to DCR. Hosts with remote HTTPS web callbacks must select `"web"`; the existing default remains `"native"` for native/loopback clients. CIMD validation checks raw path segments before the query boundary, rejecting literal, encoded, and mixed dot segments without misclassifying query text as a path.

CIMD identifiers must use explicit `https://authority/path` syntax. WHATWG-repaired missing/extra authority slashes, raw whitespace, controls and backslashes are rejected before parsing; validated raw-path extraction cannot silently fall back after a syntax mismatch. Valid case/port spelling, IPv6 authorities, percent-encoded path content and query text remain unchanged.

## Neutral server dependency boundary

The standalone server imports resource-server auth directly, which now depends on `url-policy.ts`, `contracts.ts`, `src/url.ts`, and arktype—not oauth-core, Hono, DB or hub integrations. `url-policy.ts` owns the unchanged URL checks. OAuth-only fetch and error translation live in `oauth-http.ts`; `http.ts` retains its existing exports as compatibility aliases. The aggregate auth/login facade still requires the optional OAuth integration and must not be re-exported into the neutral server runtime graph.

Invalid server configuration URLs now throw the neutral `McpAuthUrlError` rather than requiring an installed oauth-core constructor. The diagnostic name and sanitized message remain unchanged. OAuth-facing helpers translate that error to the actual public `OAuthDiscoveryError`, preserving their exception identity. No dynamic import, lazy failure, or private dependency implementation is used. The necessary server-only exception identity distinction was raised with the director, who instructed proceeding with this permitted alternative.

`boundary.test.ts` bundles both resource-server auth and the standalone server entry and rejects runtime edges to oauth-core, Hono, @intx/db, @intx/hub-api or drizzle-orm. `url-policy.test.ts` verifies neutral/facade validation parity, diagnostic parity, OAuth exception identity, and secure-fetch compatibility. The package integrator still owns optional-peer metadata changes and packed-package import checks.
