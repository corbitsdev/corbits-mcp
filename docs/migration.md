# Bidirectional API migration

## Choose the narrow entry

```ts
// Before: the historical root also imports the Interchange tool facade.
import { mcpConnect } from "@corbits/mcp";
// After, for standalone usage:
import { mcpConnect } from "@corbits/mcp/client";
```

The root, `@corbits/mcp/sidecar-bundle`, and `@corbits/mcp/hub` remain supported.
Do not change stored tool names, credential consumers or bundle IDs to migrate.
`@corbits/mcp/interchange/client` owns remote-MCP consumption;
`@corbits/mcp/interchange/server` owns explicit host exposure.
The standalone server entry exports `createMcpServer` and `createToolProviders`.

Agent/harness peers are optional at package-install time, not optional when
executing their adapters. Install `@intx/agent` and `@intx/harness` for the
historical root/Interchange consumption. Hub deployments additionally install
the hub's documented credential, DB, Hono and authorization dependencies.
The smoke test installs the packed package without peers to check standalone
imports; this is runtime import isolation, not a promise of zero dependencies.
AJV 8.20.0 and YAML 2.8.1 are lockfile-selected runtime dependencies. JSON Schema
validation must not resolve network references implicitly.

## Preserve execution and authorization semantics

- Stored-catalog `mcpServers(...)` construction stays synchronous and performs no
  network discovery at factory construction. Live `mcpTools(...)` stays async.
- Qualified names remain `<server>.<tool>`. The `mcp-server` credential and
  `@corbits/mcp/servers` consumer identity are unchanged. Do not widen grants.
- All tools start ask-marked; explicit safe-tool allowlists cannot lower a
  destructive tool's ask floor. Calling a bare ToolBundle dispatcher does not
  itself perform host authorization.
- Expose a finite list with `createInterchangeProviders`. The only tool
  authorization pair is that exposure's `resource` and `action` — the same
  pair for catalog visibility and for invocation. Do not grant a separate
  `mcp:tools` `list` or `call` action. The server gate authorizes the selected
  exposure pair, and `auth: "public"` on `createToolProviders` does not skip a
  private `createMcpServer` policy. Bind tenant and approval in the host as
  well. Catalog visibility is not execution approval; the exposure pair is
  checked again on every invocation, and `approve` runs only after it is allowed.
- Private `server/discover` returns capabilities and server info only when
  `authorize` allows at least one registered pair (each exposure's resource and
  action, or any other provider's resource and action). A principal allowed for
  none receives 403 and no discover body. A private server with no providers
  authorizes resource `mcp:server`, action `discover`. Public servers
  (`auth: "public"`) do not perform that check.
- Credential handles are mediated, origin-pinned fetches. Raw bearer values must
  never enter agent tool arguments/results, skills, task records or model context.
- Private Interchange `detail` is not automatically exported over MCP. An explicit
  result projection is required when a host deliberately exposes richer data.

## Lifecycle results are not ordinary tool output

Narrow `resultType` before reading complete-result fields. `input_required` may
repeat: fulfill only supported requests through the host UI/policy, then call
`mcpContinue` with the latest pending result. Its opaque state may be empty or
absent; do not reuse an older state's value. Decline/cancel is not approval.
Tasks are negotiated per request and only augment `tools/call` in the pinned
revision. Missing lifecycle services mean unavailable/unsupported, not success,
a fabricated pending marker, or a new grantable tool.

For durable tasks, supply atomic persistence and a recoverable executor. An
in-memory store or surviving Promise is not production durability. A reference
single-host file store does not imply distributed/multi-writer support. Persist
dispatch intent before non-idempotent workflow mail and reconcile ambiguous
crashes rather than automatically replaying them. Bind result selection to the
specific run/message/correlation, not all events of a shared workflow.

`Agent.send` cancellation in Interchange 0.5.0 cancels the waiter, not the active
reactor cycle. Never close a shared agent for a single MCP call. Dedicated
workflow runs can request durable cooperative cancellation, which still is not
an immediate termination guarantee.

## Security tightening

Malformed wire envelopes, unsupported polymorphic result types, wrong header
mirrors, invalid schema/data, unauthorized selections and unnegotiated extension
operations are errors rather than permissive passthrough. Modern HTTP cancellation
closes the response stream; it must not send the stdio cancellation notification.
OAuth issuer equality is exact (trailing-slash aliases are not equivalent);
resource indicators apply to authorization, code exchange and refresh. Reject
credential-bearing/fragment endpoints and traversal before URL normalization.
These corrections intentionally reject unsafe inputs previously accepted.

## Extension deployment checklist

- Tasks: opt-in capability, durable store, recoverable backend, identity isolation,
  TTL cleanup, explicit outstanding-input and cancellation authority.
- Skills: verified origin-scoped manifest and bytes, bounded YAML/parser/filesystem
  access, explicit approval and provenance. Verification/read is not activation:
  the host must gate context admission and all code-execution tools during the
  approved acting window, including revocation/expiry.
- Apps: advertisement requires explicit host support and bridge, sandbox/CSP/
  authenticated-bridge commitments, and presentation. Metadata-only handling
  never advertises Apps. The host supplies and enforces the actual renderer,
  origins and UI lifecycle; the package gate does not implement that renderer.
- HTTP operations: authored finite method/path bindings, host-authenticated app
  dispatch, fixed tenant/path/origin and explicit result mapping. No automatic
  exposure of every OpenAPI operation or hub administration route.

See [conformance evidence](conformance.md) for revision pins and pending coverage.
No release should claim full conformance while those requirements lack test evidence.

## Public extension factories and guarded authorization

The explicit server-only `@corbits/mcp/server/task-store` subpath exposes
`createFileTaskStore`; it is not imported by the neutral client. Guarded OAuth
host APIs are now exported at the historical root (`createMcpAuthorizationSession`,
`prepareMcpClient`, `refreshMcpOAuthTokens`, callback and auth helpers).
Root import consumers still need their historical Interchange dependencies.

Publisher/task-runtime/server-auth and host skill-loader factories are now exported
through their role entries and exercised from installed tarballs. OAuth-core is now an optional peer: historical root and guarded login consumers
must explicitly install `@corbits/oauth-core@^0.3.0` alongside their agent/harness
peers. Neutral client/server consumers need none of those optional host packages.
Packed auth fixtures explicitly install OAuth-core 0.3.0. See
[public API](public-api.md) for the neutral URL-error class distinction and the
companion credential-http harness/types 0.5.0 support requirement.

## Legacy server rollout

Legacy compatibility is implemented behind `createMcpServer({ legacy: ... })`,
not enabled by default. See [legacy-server.md](legacy-server.md) for the exact
three revisions, session affinity/restart loss, default 1,024-session/30-minute
bounds, 10,000 request IDs, initialization authorization, March-only batches and
GET405/no-resumption limits. Modern requests remain stateless.

## External companion follow-ups

CL11479 tracks stock OAuth-core token-only/redirect/error/protected-parameter
defects, not a generic deployment task. CL11480 tracks credential-http peer
compatibility plus Request+init and configured-scheme policy defects. Guarded
local login and neutral package isolation do not repair those external stock
paths. See [public API limits](public-api.md); do not force dependency resolution
or infer production-host approval from installed fixture results.
