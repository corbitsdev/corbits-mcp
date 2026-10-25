# AGENTS.md

## Purpose

`@corbits/mcp` turns each tool on a remote MCP server into its own `@intx/agent` tool for the Interchange sidecar. The client speaks MCP **2026-07-28** (stateless `server/discover`, per-request `_meta` and `Mcp-*` headers). A server that does not implement `server/discover`, times out, or only speaks `2025-11-25` / `2025-06-18` / `2025-03-26` / `2024-11-05` falls back to `initialize` plus `Mcp-Session-Id`. It owns the MCP client, tool naming and the ask floor, the sidecar-bundle factory, the hub catalog-discovery route and MCP OAuth discovery. It does not own the OAuth login itself (`@corbits/oauth-core`) or credential storage (the hub).

## Layout

- `src/client.ts`: streamable-HTTP JSON-RPC client. `mcpConnect` probes `server/discover`. Modern calls are `tools/list`, `tools/call`, `prompts/list`, `prompts/get`, `resources/list`, `resources/read`, `resources/templates/list`, `completion/complete`, and `subscriptions/listen`. `mcpInitialize` is the explicit legacy handshake. Extensions (`io.modelcontextprotocol/tasks`, `io.modelcontextprotocol/ui`, `io.modelcontextprotocol/skills`) are advertised and sent only when the caller opts in by extension id.
- `src/tool.ts`: `mcpTools`, one `@intx/agent` tool per remote MCP tool, named `<server>.<tool>`.
- `src/naming.ts`: qualified names and the ask floor, shared by `mcpTools` and the sidecar bundle.
- `src/url.ts`: which MCP endpoints a token may be sent to.
- `src/oauth-discovery.ts`: MCP OAuth metadata discovery, Client ID Metadata Documents, dynamic client registration, issuer-keyed stored credentials, and RFC 9207 `iss` checks before a code is read.
- `src/sidecar-bundle.ts`: the `./sidecar-bundle` entry a deployed agent's bundle loads.
- `src/hub/discover.ts`, `src/hub/index.ts`: the `./hub` entry, server-side catalog discovery.
- `src/test-server.ts`: in-test MCP server used by the tests.
- `src/index.ts`: the root entry.

## Rules

### Split discovery and calling

Discovery and calling are split, because a deployed agent's tool factories
are evaluated synchronously when the agent is constructed and the agent must
never hold a server's bearer.

1. **The deployer discovers the catalog once**, server-side, through the hub
   route this package mounts. The browser never holds an MCP token, so this
   is the only way an OAuth-protected server's `tools/list` can be read.
2. **The catalog is stored** with the rest of the agent's deploy config.
3. **`mcpServers` turns the stored catalog into tools.** Construction is
   synchronous and does no network work: names and `ask` marks come from the
   stored catalog. By contrast, `mcpTools` is asynchronous and discovers the
   remote catalog live before building tools.
4. **At run time the agent only ever sees a mediated handle.** Each server's
   credential resolves to an `http` handle (a fetch pinned to the credential's
   origin that injects the bearer per request), so the token never reaches
   agent code, and a relative path is all the bundle ever asks for.

### Why not `@modelcontextprotocol/sdk`

The client in `src/client.ts` is hand-rolled on purpose. A 2026 server gets
one POST per call after `server/discover`: protocol version, client info, and
client capabilities travel in `_meta`, and `Mcp-Method` / `Mcp-Name` /
`MCP-Protocol-Version` travel as headers. There is no session id, no
`initialize`, and no `notifications/initialized` on that path. A call made with
no session speaks this stateless path directly. `input_required`
comes back as a typed result and `mcpContinue` retries the original method
with `inputResponses`. `subscriptions/listen` is the long-lived stream.
`notifications/progress` stays on the response stream of the call that asked
for it. Modern HTTP cancellation closes the response stream; it does not post `notifications/cancelled`.

A legacy server still gets `initialize`, `notifications/initialized`, and
`Mcp-Session-Id`. In the sidecar bundle every request goes through a fetch
the mediated credential handle pins to the server's origin.

The SDK's streamable-HTTP client transport is built for long-lived sessions
(resumable streams, server-initiated requests) and installs server-framework dependencies this client does not need. Shared wire/schema validation now uses a directly declared AJV dependency, not the SDK runtime. Resumable streams
(`Last-Event-ID`), the removed HTTP+SSE transport, modern `ping`, and the deprecated
roots, sampling, and logging methods are not implemented. `e2e/` runs
discovery and tool calls against the SDK's stateless and stateful 2025
transports and against a small 2026 fixture; the SDK is a devDependency only.
Prompts, resources, and subscriptions are client methods. They are not
projected into agent tools, and tools stay the only grantable unit.

## Local development

```sh
bun install && bun run check && bun run test:e2e
```

## Conventions

- Read `README.md` before changing public behavior.
- Keep changes focused; update docs and tests alongside code changes.
- Run `bun run check` before declaring work complete.

## Bidirectional package boundaries

- `./client` and `./server` are standalone entries. Never import agent, harness, hub, DB or Hono runtime code into their dependency graph.
- `./interchange/client` consumes remote MCP; `./interchange/server` exposes only explicitly selected host bindings. Preserve the root, sidecar-bundle and hub facades.
- Shared wire validation belongs in `src/protocol`; extension runtimes accept transport/provider interfaces instead of importing client facades.
- Runtime JSON Schema validation uses declared AJV; skill YAML parsing uses declared YAML. The MCP SDK remains development-only and only tests legacy transport interoperability.
- `docs/conformance.md` tracks role/revision/capability-qualified evidence; never infer complete conformance from aggregate test counts.
- Package gates: `bun run check`, `bun run test:e2e`, `bun run build`, `bun run test:package`. The packed smoke suite requires npm, registry access and Node 24+.

## Server compatibility and capability gates

- `createMcpServer` is modern/stateless by default. Explicit `legacy` options
  enable the three 2025 Streamable HTTP revisions; see docs/legacy-server.md for
  session bounds, affinity/restart behavior, initialization authorization and
  March-only batches. Do not describe this implemented shim as missing.
- Apps metadata is not host support. Advertisement requires explicit host bridge,
  sandbox/CSP/authenticated-bridge support and presentation; actual rendering is
  host-owned. Keep metadata-only hosts unadvertised.
- OAuth-core is an optional peer required by root/guarded login, not by neutral
  client/server. Keep stock dependency defects CL11479/CL11480 distinct from
  local guarded behavior and from application deployment obligations.
- Shared-worktree build/pack gates must run serially; record exact runtime
  versions and do not infer final Node26 evidence from earlier Node24 results.
