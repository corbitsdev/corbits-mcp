# Contributing

## Development

Requires Bun 1.2+.

```bash
bun install
bun run build
bun run check
```

`check` runs typecheck, lint, format check and tests. The tests start local
MCP servers with `Bun.serve` and make no network calls.

## Design: split discovery and calling

Discovery and calling are split, because a deployed agent's tool factories
are evaluated synchronously when the agent is constructed and the agent must
never hold a server's bearer.

1. **The deployer discovers the catalog once**, server-side, through the hub
   route this package mounts. The browser never holds an MCP token, so this
   is the only way an OAuth-protected server's `tools/list` can be read.
2. **The catalog is stored** with the rest of the agent's deploy config.
3. **`mcpServers` turns it into tools.** It is synchronous and does no
   network work at construction: the names and the `ask` marks come from the
   stored catalog.
4. **At run time the agent only ever sees a mediated handle.** Each server's
   credential resolves to an `http` handle (a fetch pinned to that server's
   origin that injects the bearer per request), so the token never reaches
   agent code, and a relative path is all the bundle ever asks for.

## Why not `@modelcontextprotocol/sdk`

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

## Commit messages

Commit subjects and PR titles follow [Conventional Commits](https://www.conventionalcommits.org): `feat`, `fix`, `refactor`, `test`, `docs`, `build`, `ci`, `perf`, and `chore(release): x.y.z` for releases.
Add `!` only for public API breaks: removed or renamed exports, changed signatures, newly required params. Peer and dependency range changes are `build(deps):` with no `!`.
Keep subjects imperative, lowercase after the colon, 72 characters or less, and free of ticket IDs.
Every PR links its issue with a `Closes <issue id>` line in the PR body.
