# @corbits/mcp

An MCP client for Interchange: streamable HTTP transport (2025-03-26 spec),
one `@intx/agent` tool per remote tool, and no gate of its own -- native
per-tool grants check the whole surface.

## Shape

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
   credential resolves to an `http` handle -- a fetch pinned to that server's
   origin that injects the bearer per request -- so the token never reaches
   agent code, and a relative path is all the bundle ever asks for.

### Hub

```ts
import { mountMcpDiscovery } from "@corbits/mcp/hub";

const api = new Hono<TenantEnv>();
mountMcpDiscovery(api, { db, cipher, requireGrant });
app.route("/api/tenants/:tenantId", api);
```

`POST /api/tenants/:tenantId/mcp/discover` with `{ url, credentialId? }`
answers `{ data: { serverInfo, tools } }`. `url` must be https (http only on
loopback); `credentialId` names a tenant credential whose secret is sent as a
bearer, and the keyless sentinel sends no `authorization` header at all. The
outbound fetch is origin-pinned and refuses a 3xx, so the secret never leaves
the server's own origin.

### Sidecar bundle

```ts
import { mcpServers } from "@corbits/mcp/sidecar-bundle";

export const tools = mcpServers({
  servers: [
    {
      handle: "linear",
      url: "https://mcp.linear.app/mcp",
      tools: storedCatalog,
      allowWithoutAsk: ["linear.list_issues"],
    },
  ],
});
```

Each catalog entry becomes a tool named `<handle>.<tool>`, with the remote
`inputSchema` passed through verbatim and its call proxied to `tools/call`. A
result's text content comes back as text and anything else as JSON; `isError`
passes through. A handle that will not resolve, or a server that fails
`initialize`, fails only that server's calls.

`mcpTools` (the root export) is the author-time equivalent, for code that can
await discovery itself.

## Grants

Every call is checked as resource `tool:<name>`, most specific match wins,
`deny` beats `ask` beats `allow`. Because each remote tool is its own agent
tool, `tool:<handle>.<tool>` is grantable individually and `tool:<handle>.*`
covers a whole server.

Every generated tool starts `ask`-marked. Listing `"<handle>.<tool>"` in
`allowWithoutAsk` is the only way to lower that mark, and it is ignored for
any remote tool the server flags `destructiveHint: true`.

## License

LGPL-2.1-only.
