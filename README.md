# @corbits/mcp

A Corbits tool pack for the Interchange sidecar that turns each tool on a remote Model Context Protocol server into its own `@intx/agent` tool, over streamable HTTP (2025-03-26 spec). It also ships a hub route for catalog discovery and OAuth discovery helpers, and the client works standalone.

## Why @corbits/mcp?

1. **One agent tool per remote tool.** `linear.list_issues` and `linear.delete_issue` are separate tools, so Interchange grants (per-principal permission records) allow, ask or deny each one.
2. **The agent never holds the server's token.** Calls go through a mediated credential: a fetch pinned to the server's origin that adds the bearer per request.
3. **Destructive tools stay behind approval.** Every generated tool starts `ask`-marked, and a tool the server flags `destructiveHint: true` cannot be lowered to `allow`.

It supports `initialize`, `tools/list` and `tools/call` only. It does not send `Mcp-Session-Id`, so servers that require a session are not supported.

## Install

```bash
bun add @corbits/mcp @intx/agent @intx/harness
```

Runs on Node.js 24+ and Bun 1.2+.

For the `@corbits/mcp/hub` routes, also install:

```bash
bun add @corbits/credential-mcp @intx/authz @intx/crypto @intx/db @intx/hub-api drizzle-orm hono
```

## Quickstart

Lists the tools on a public MCP server:

```ts
import { mcpInitialize, mcpListTools } from "@corbits/mcp";

const url = "https://mcp.deepwiki.com/mcp";
await mcpInitialize(url);
for (const tool of await mcpListTools(url)) {
  console.log(`${tool.name}: ${tool.description ?? ""}`);
}
```

Every client call takes `{ fetch }` as its last argument, for example a fetch that adds an `Authorization` header.

## Where it fits

[Interchange](https://github.com/faremeter/interchange) runs AI agents as principals: accounts with their own identity, permissions and credentials. Its hub is the multi-tenant control plane that holds tenants, grants and credentials; its sidecar is the agent runtime.

- **Hub:** `@corbits/mcp/hub` mounts a discovery route on an [`@intx/hub-api`](https://github.com/faremeter/interchange/tree/main/packages/hub-api) app and reads tenant credentials from [`@intx/db`](https://github.com/faremeter/interchange/tree/main/packages/db).
- **Sidecar:** `@corbits/mcp/sidecar-bundle` builds [`@intx/agent`](https://github.com/faremeter/interchange/tree/main/packages/agent) tools from a stored catalog.
- **Pairs with:** [`@corbits/oauth-core`](https://github.com/corbitsdev/corbits-oauth-core) for the login flow and [`@corbits/credential-mcp`](https://github.com/corbitsdev/corbits-credential-mcp) for the origin-pinned credential provider.

## Reference

| Export                                                  | Entry                         | Purpose                                                                                                           |
| ------------------------------------------------------- | ----------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `mcpInitialize(url, opts?)`                             | `@corbits/mcp`                | Send `initialize`; returns `serverInfo` and `protocolVersion`.                                                    |
| `mcpListTools(url, opts?)`                              | `@corbits/mcp`                | Send `tools/list`; returns `McpTool[]`.                                                                           |
| `mcpCallTool(url, name, args, opts?)`                   | `@corbits/mcp`                | Send `tools/call`; returns `McpToolResult`.                                                                       |
| `mcpTools(options, env?)`                               | `@corbits/mcp`                | Discover each server live, then build tools. For hosts that can await; servers use `name` and `credentialHandle`. |
| `qualifiedName`, `toolDescription`, `isAskExempt`       | `@corbits/mcp`                | Naming and `ask`-floor rules the tool builders use.                                                               |
| `discoverMcpLoginEntry({ resourceUrl })`                | `@corbits/mcp`                | Resolve the authorization server (RFC 9728, then RFC 8414).                                                       |
| `registerMcpClient(opts)`                               | `@corbits/mcp`                | Register a loopback public client (RFC 7591).                                                                     |
| `mcpClientConfig(entry, opts)`                          | `@corbits/mcp`                | Build the `OAuthClientConfig` oauth-core's login helpers take.                                                    |
| `selectMcpScopes(opts)`                                 | `@corbits/mcp`                | Pick scopes in the MCP spec's selection order.                                                                    |
| `mcpServers(config)`                                    | `@corbits/mcp/sidecar-bundle` | Build tools from stored catalogs over mediated credentials.                                                       |
| `shapeMcpContent(content)`, `SIDECAR_BUNDLE_ID`         | `@corbits/mcp/sidecar-bundle` | Result shaping and the bundle's tool id.                                                                          |
| `mountMcpDiscovery(app, opts)`                          | `@corbits/mcp/hub`            | Mount `POST /mcp/discover`.                                                                                       |
| `discoverMcpServer(args)`, `readCredentialSecret(opts)` | `@corbits/mcp/hub`            | The discovery and credential reads the route uses.                                                                |

`McpToolSchema` validates a catalog entry (`McpTool`). Transport and protocol failures throw `McpError`. OAuth discovery failures throw `OAuthDiscoveryError` from `@corbits/oauth-core`.

### Grants

Every call is checked as resource `tool:<name>`. The most specific match wins, and `deny` beats `ask` beats `allow`. `tool:<handle>.<tool>` grants one remote tool and `tool:<handle>.*` covers a whole server.

List `"<handle>.<tool>"` in `allowWithoutAsk` to let an `allow` grant run that tool without approval. The list is ignored for tools flagged `destructiveHint: true`.

## Using with Interchange

The deployer discovers a server's catalog once through the hub route and stores it with the agent's deploy config. The sidecar bundle turns the catalog into tools that call through a mediated credential.

### Mount the hub route

```ts
import { mountMcpDiscovery } from "@corbits/mcp/hub";
import { timeWindowEvaluator } from "@intx/authz";
import { createEnvKeyCredentialCipher } from "@intx/crypto";
import { createDB, createGrantStore } from "@intx/db";
import { createRequireGrant, type TenantEnv } from "@intx/hub-api";
import { Hono } from "hono";

const { db } = createDB({
  host: "localhost",
  port: 5432,
  user: "postgres",
  password: "postgres",
  database: "interchange",
});
const requireGrant = createRequireGrant({
  grantStore: createGrantStore(db),
  conditionRegistry: { time_window: timeWindowEvaluator },
});

export const mcpRoutes = new Hono<TenantEnv>();
mountMcpDiscovery(mcpRoutes, {
  db,
  cipher: createEnvKeyCredentialCipher(
    Buffer.from(String(process.env["CREDENTIAL_ENCRYPTION_KEY"]), "hex"),
  ),
  requireGrant: requireGrant("credential:*", "read"),
});
```

Mount `mcpRoutes` on the hub app under `/api/tenants/:tenantId`, behind the hub's auth and tenant middleware.

`POST /api/tenants/:tenantId/mcp/discover` with `{ url, credentialId? }` returns `{ data: { serverInfo, tools } }`. `url` must be https (http only on loopback). `credentialId` names a tenant credential whose secret is sent as a bearer; a credential holding `MCP_NO_TOKEN_SENTINEL` from `@corbits/credential-mcp` sends no `authorization` header. Errors: 400 for a bad body or URL, 404 for an unknown credential, 422 when the server fails discovery. `requireGrant` is the host's own grant middleware for this route. The fetch is pinned to the server's origin and refuses redirects, so the secret never leaves that origin.

### Load the sidecar bundle

```ts
import { mcpListTools } from "@corbits/mcp";
import { mcpServers } from "@corbits/mcp/sidecar-bundle";

const url = "https://mcp.deepwiki.com/mcp";

export const tools = mcpServers({
  servers: [
    {
      handle: "deepwiki",
      url,
      tools: await mcpListTools(url),
      allowWithoutAsk: ["deepwiki.read_wiki_structure"],
    },
  ],
});
```

Each catalog entry becomes a tool named `<handle>.<tool>`, with the remote `inputSchema` passed through and the call proxied to `tools/call`. Text content comes back as text and anything else as JSON; `isError` passes through. A handle that does not resolve, or a server that fails `initialize`, fails only that server's calls.

`handle` is the credential handle the host binds this server's token to. The bundle resolves it from the runtime `credentials` capability and expects an `http` credential, such as the one `@corbits/credential-mcp`'s provider returns. The package manifest declares the `mcp-server` credential for this.

### Grant access

Grant the agent's principal `tool:deepwiki.*` for the whole server, or `tool:deepwiki.<tool>` per tool, with `allow`, `ask` or `deny`.

## Upgrading from 0.1

- Existing server configs, stored catalogs and the `mcp-server` credential keep working unchanged.
- `@intx/harness` is a required peer. Import `FetchLike` from it; `@corbits/mcp` no longer exports that type.
- `@intx/db`, `@intx/hub-api`, `drizzle-orm`, `hono` and `@corbits/credential-mcp` are optional peers. Install them if you use `@corbits/mcp/hub`.
- `@intx/agent` and `@intx/harness` peers are `^0.4.0`.
- Discovery rejects authorization-server metadata whose `issuer` differs from the one the protected resource names.

## License

[LGPL-2.1-only](https://github.com/corbitsdev/corbits-mcp/blob/main/LICENSE)
