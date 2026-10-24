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
3. **`mcpTools` turns it into tools.** It is synchronous and does no
   network work at construction: the names and the `ask` marks come from the
   stored catalog.
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
for it. Aborting an in-flight call posts `notifications/cancelled`.

A legacy server still gets `initialize`, `notifications/initialized`, and
`Mcp-Session-Id`. In the sidecar bundle every request goes through a fetch
the mediated credential handle pins to the server's origin.

The SDK's streamable-HTTP client transport is built for long-lived sessions
(resumable streams, server-initiated requests) and installs `zod`, `ajv`,
`express` and more, none of which this package uses. Resumable streams
(`Last-Event-ID`), the removed HTTP+SSE transport, `ping`, and the deprecated
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
