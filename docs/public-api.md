# Public extension and authorization API

Status: integration followup, 2026-10-25. Factory exports are implemented and
installed behavior is tested; OAuth-core is an optional host peer.

| Entry                             | Public API                                                                                                                                                                                       |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `@corbits/mcp/client`             | Standalone client functions and wire types                                                                                                                                                       |
| `@corbits/mcp/server`             | Server/provider factories, `createSkillPublisher`, skill contracts, `createTaskRuntime`, `validateTaskRecord`, task contracts, `createMcpResourceServerAuth`, auth policy/identity/options types |
| `@corbits/mcp/server/task-store`  | `createFileTaskStore` (explicit filesystem entry only)                                                                                                                                           |
| `@corbits/mcp/interchange/client` | Existing tool/server/host APIs plus `createSkillLoader`, `parseSkillFrontmatter`, `SKILL_LIMITS`, skill contracts                                                                                |
| `@corbits/mcp/interchange/server` | Explicit selected host exposure contracts and providers                                                                                                                                          |
| `@corbits/mcp`                    | Historical facade and guarded authorization APIs                                                                                                                                                 |

Facade changes add reexports only. No filesystem store is exported through a
neutral barrel. The file store requires a private host-owned directory and one
writer; stale-lock recovery requires proof the previous writer is dead.

## Dependency boundary and setup

OAuth-core is an optional peer (`^0.3.3`) and pinned development dependency
(0.3.3). Neutral client/server entries do not require it. Root and guarded OAuth
login users must explicitly install OAuth-core plus the root's agent/harness
peers (`@intx/harness` `^0.5.0`); this is a breaking change from automatic OAuth installation. Host/auth
packed fixtures explicitly install these dependencies. OAuth-core itself still
transitively installs DB/hub/Hono; that cost belongs to the opt-in host setup.

Resource-server URL validation now uses the neutral auth URL-policy seam. Its
errors retain the diagnostic `OAuthDiscoveryError` name/message/detail but are
not instances of OAuth-core's error class. OAuth-facing helpers translate to the
actual OAuth-core `OAuthDiscoveryError` class. Neutral consumers must not import
the optional OAuth implementation merely to perform an `instanceof` check.

```sh
npm install @corbits/mcp @corbits/oauth-core@0.3.3 @intx/agent@0.5.0 @intx/harness@0.5.0
```

`@corbits/credential-http` is an optional peer (`^0.1.3`). Install
`@corbits/credential-http@0.1.3`. That release accepts `@intx/harness` and
`@intx/types` `^0.5.0`.

## Installed evidence

The final optional-peer tarball fixtures pass on Bun 1.4.2 and Node 24.22.1:
publisher bytes/metadata, task close/reopen/recovery without replay and principal
isolation, injected resource-auth verifier/challenge/metadata, skill verification
and refusal to activate without policy, historical facade identity, and guarded
OAuth PKCE/resource/cancellation. These are scoped fixture assertions, not live
OAuth interoperability, cryptographic-verifier certification or full conformance.

Package tests use ordinary npm installs (no peer omission), reject absent public
exports, assert unwanted dependencies are absent, and check both neutral module
graphs. These checks validate the dependency boundary; see [integration status](integration-status.md) for command evidence.

## Legacy public options and Apps gate

The server entry exposes `McpLegacyOptions` / `McpLegacyRevision`; the installed
legacy smoke exercises `createMcpServer({ legacy: ... })` for all three 2025
revisions. See [legacy-server.md](legacy-server.md) for bounds and deployment
requirements. Modern mode stays session-free by default.

Interchange Apps advertisement requires explicit `apps` bridge/support and
presentation, including sandbox renderer, CSP enforcement and authenticated
bridge support. Metadata-only presentation does not advertise Apps. The host
must implement the renderer and enforce these commitments.

## Guarded path versus external companion defects

**CL11479:** OAuth-core 0.3.0 stock BaseTokens/conversion/storage requires refresh
material even for valid access-token-only grants. Stock token POST follows
redirects and exposes raw response error bodies, and authorization extras can
overwrite protected state/PKCE. The guarded MCP login/session path supports
access-only tokens through honest host persistence, refuses redirects, sanitizes
errors and rejects protected overrides; it does not fix stock helpers.

Additional documented stock hub limits are DCR-only registration selection and
present-but-unadvertised `iss` not being checked on the stock callback path.
These integration limits are distinct from the exact CL11479 issue acceptance.
Use guarded preparation/session/callback seams rather than assuming the stock
provider/hub path has equivalent checks. OAuth-core already propagates resource
on code exchange and refresh; the local config-builder omission was fixed, not
an absent upstream feature.

**CL11480:** credential-http 0.1.0 ignored Request+init overrides in its Request
branch and permitted insecure configured credential destination schemes. Peer
`^0.1.3` accepts `@intx/harness` and `@intx/types` `^0.5.0`. Local hub
endpoint/redirect checks do not fix standalone external provider handles.
Upstream correction and host transport policy remain required; no external
package was patched here.

The source audit is recorded in `src/auth/INTEGRATION.md`; this public summary
keeps the relevant limits available in the packed docs. Production encrypted
storage/authority, live callback listeners, consent, actual cryptographic token
verification, egress/DNS policy and distributed durability remain host obligations.

## Verified Skills supported shapes

The verified Skills loader declines dynamic manifests. This refusal is permitted
by the pinned Skills specification; dynamic consumption is not a newly missing
mandatory capability or an expansion of this adapter's implementation scope.
The adapter requires a complete resource read containing exactly one text or
blob item whose URI matches the requested resource. Resource-read MRTR
(`input_required`) is unsupported by this verified adapter; generic client MRTR
support does not imply that the Skills adapter can fulfill it. These supported-
shape limits are separate from the approved decoded-size and integrity bounds.
