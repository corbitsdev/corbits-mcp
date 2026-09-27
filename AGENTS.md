# AGENTS.md

## Purpose

`@corbits/mcp` turns each tool on a remote MCP server (streamable HTTP, 2025-03-26 spec) into its own `@intx/agent` tool for the Interchange sidecar. It owns the MCP client, tool naming and the ask floor, the sidecar-bundle factory, the hub catalog-discovery route and MCP OAuth discovery. It does not own the OAuth login itself (`@corbits/oauth-core`) or credential storage (the hub).

## Layout

- `src/client.ts`: streamable-HTTP JSON-RPC client (`initialize`, `tools/list`, `tools/call`).
- `src/tool.ts`: `mcpTools`, one `@intx/agent` tool per remote MCP tool, named `<server>.<tool>`.
- `src/naming.ts`: qualified names and the ask floor, shared by `mcpTools` and the sidecar bundle.
- `src/url.ts`: which MCP endpoints a token may be sent to.
- `src/oauth-discovery.ts`: MCP OAuth metadata discovery and dynamic client registration.
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
   credential resolves to an `http` handle (a fetch pinned to that server's
   origin that injects the bearer per request), so the token never reaches
   agent code, and a relative path is all the bundle ever asks for.

### Why not `@modelcontextprotocol/sdk`

The client in `src/client.ts` is hand-rolled on purpose. It only sends
`initialize`, `tools/list` and `tools/call`, each as one request awaiting one
reply; in the sidecar bundle that request goes through a fetch the mediated
credential handle pins to the server's origin. That needs only JSON-RPC
framing and reading the matching `data:` frame from an event-stream reply.

The SDK's streamable-HTTP client transport is built for long-lived sessions
(resumable streams, server-initiated requests) and installs `zod`, `ajv`,
`express` and more, none of which this package uses.

The cost: the client never sends `Mcp-Session-Id`, so a server that issues
one on `initialize` and requires it afterwards rejects `tools/list` and
`tools/call`. Notifications and server-to-client requests are not
supported either.

## Local development

```sh
bun install && bun run check
```
