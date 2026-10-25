# @corbits/mcp

A Corbits tool pack for the Interchange sidecar that turns each tool on a remote Model Context Protocol server into its own `@intx/agent` tool, over streamable HTTP. The client speaks the 2026-07-28 revision and falls back to the 2025 `initialize` handshake when the server does not. It also ships a hub route for catalog discovery and OAuth discovery helpers, and the client works standalone.

## Why @corbits/mcp?

1. **One agent tool per remote tool.** `linear.list_issues` and `linear.delete_issue` are separate tools, so Interchange grants (per-principal permission records) allow, ask or deny each one.
2. **The agent never holds the server's token.** Calls go through a mediated credential: a fetch pinned to the server's origin that adds the bearer per request.
3. **Destructive tools stay behind approval.** Every generated tool starts `ask`-marked, and a tool the server flags `destructiveHint: true` cannot be lowered to `allow`.

`mcpConnect` probes `server/discover`. A 2026-07-28 server is stateless: later calls send `MCP-Protocol-Version`, `Mcp-Method`, and `Mcp-Name`, and carry `io.modelcontextprotocol/protocolVersion`, `clientInfo`, and `clientCapabilities` in `_meta`. They do not send `initialize`, `notifications/initialized`, or `Mcp-Session-Id`. A call made with no session speaks this stateless path directly; a session handed over from `mcpConnect` is stateless too. If `server/discover` is missing, times out, or the server only speaks a 2025 (or earlier) version, the client keeps the `initialize` plus `Mcp-Session-Id` path.

Core methods, paginated where the spec uses a cursor: `tools/list`, `tools/call`, `prompts/list`, `prompts/get`, `resources/list`, `resources/read`, `resources/templates/list`, `completion/complete`. A missing `resultType` is `complete`. `input_required` is returned to the caller (method, `inputRequests`, `requestState`) and retried with `mcpContinue`. `subscriptions/listen` is a long-lived POST; `notifications/progress` stays on the call that asked for it; aborting an in-flight call sends `notifications/cancelled`.

Extensions are off unless named in `extensions`: `io.modelcontextprotocol/tasks` (`tasks/get`, `tasks/update`, `tasks/cancel`, and a `task` result), `io.modelcontextprotocol/ui` (capability advertisement and passthrough of tool-result UI metadata; no widget renderer), and `io.modelcontextprotocol/skills` (`skills/list`, `skills/get`, with `resources/directory/read` only when the server declares `directoryRead`). Roots, sampling, logging, `ping`, HTTP+SSE, and SSE resumption are not implemented. Prompts, resources, and subscriptions are not projected into agent tools. Tools remain the only grantable unit. Catalog entries keep `outputSchema`, `annotations.title`, the four boolean hints, `ttlMs`, and `cacheScope`. JSON Schema is passed through, including unknown 2020-12 keywords.

## Install

```bash
bun add @corbits/mcp @intx/agent @intx/harness
```

Runs on Node.js 24+ and Bun 1.2+.

For the `@corbits/mcp/hub` routes, also install:

```bash
bun add @corbits/credential-http @intx/authz @intx/crypto @intx/db @intx/hub-api drizzle-orm hono
```

## Quickstart

Lists the tools on a public MCP server:

```ts
import { mcpConnect, mcpListTools } from "@corbits/mcp";

const url = "https://mcp.deepwiki.com/mcp";
const session = await mcpConnect(url);
for (const tool of await mcpListTools(url, { session })) {
  console.log(`${tool.name}: ${tool.description ?? ""}`);
}
```

Every client call takes `{ fetch, timeoutMs, signal, session }` as its last argument, for example a fetch that adds an `Authorization` header. `timeoutMs` covers the request and reading its body, and `signal` cancels both. `mcpTools` and `mcpServers` take a `timeoutMs` option, 60 seconds by default, and pass each tool call's abort signal through, so a stalling server fails that call instead of hanging it. A response body or event-stream frame over 4 MiB is refused and the stream cancelled.

## Where it fits

[Interchange](https://github.com/faremeter/interchange) runs AI agents as principals: accounts with their own identity, permissions and credentials. Its hub is the multi-tenant control plane that holds tenants, grants and credentials; its sidecar is the agent runtime.

- **Hub:** `@corbits/mcp/hub` mounts a discovery route on an [`@intx/hub-api`](https://github.com/faremeter/interchange/tree/main/packages/hub-api) app and reads tenant credentials from [`@intx/db`](https://github.com/faremeter/interchange/tree/main/packages/db).
- **Sidecar:** `@corbits/mcp/sidecar-bundle` builds [`@intx/agent`](https://github.com/faremeter/interchange/tree/main/packages/agent) tools from a stored catalog.
- **Pairs with:** [`@corbits/oauth-core`](https://github.com/corbitsdev/corbits-oauth-core) for the login flow and [`@corbits/credential-http`](https://github.com/corbitsdev/credential-http) for the origin-pinned credential provider.

## Reference

| Export                                                                                                                          | Entry                         | Purpose                                                                                                                                   |
| ------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `mcpConnect(url, opts?)`                                                                                                        | `@corbits/mcp`                | Probe `server/discover`, or fall back to `initialize`; returns the `McpSession` for later calls.                                          |
| `mcpInitialize(url, opts?)`                                                                                                     | `@corbits/mcp`                | Explicit legacy `initialize` and `notifications/initialized`.                                                                             |
| `mcpListTools(url, opts?)`                                                                                                      | `@corbits/mcp`                | Send `tools/list`; returns `McpTool[]` with `ttlMs` and `cacheScope` when the server sent them.                                           |
| `mcpCallTool(url, name, args, opts?)`                                                                                           | `@corbits/mcp`                | Send `tools/call`. A complete result, `input_required`, or (when tasks are enabled) a task handle.                                        |
| `mcpContinue(url, pending, inputResponses, opts?)`                                                                              | `@corbits/mcp`                | Retry an `input_required` result, echoing `requestState`.                                                                                 |
| `mcpListPrompts`, `mcpGetPrompt`, `mcpListResources`, `mcpReadResource`, `mcpListResourceTemplates`, `mcpComplete`, `mcpListen` | `@corbits/mcp`                | The rest of the core client. Prompts, resources, and subscriptions are not agent tools.                                                   |
| `mcpTools(options, env?)`                                                                                                       | `@corbits/mcp`                | Discover each server live, then build tools. For hosts that can await; servers use `name` and `credentialHandle`.                         |
| `qualifiedName`, `toolDescription`, `isAskExempt`                                                                               | `@corbits/mcp`                | Naming and `ask`-floor rules the tool builders use.                                                                                       |
| `discoverMcpLoginEntry({ resourceUrl })`                                                                                        | `@corbits/mcp`                | Resolve the authorization server (RFC 9728, then RFC 8414).                                                                               |
| `registerMcpClient(opts)`                                                                                                       | `@corbits/mcp`                | Register a public client (RFC 7591), `application_type` `"native"` unless set.                                                            |
| `preferredMcpClientRegistration`, `mcpClientIdMetadataDocument`, `resolveStoredMcpClient`                                       | `@corbits/mcp`                | Pre-registered, then Client ID Metadata Documents, then dynamic registration. Dynamic and pre-registered credentials are keyed by issuer. |
| `assertAuthorizationIssuer`, `readAuthorizationCallback`                                                                        | `@corbits/mcp`                | Check RFC 9207 `iss` against the recorded issuer before the code is read.                                                                 |
| `mcpClientConfig(entry, opts)`                                                                                                  | `@corbits/mcp`                | Build the `OAuthClientConfig` oauth-core's login helpers take.                                                                            |
| `selectMcpScopes(opts)`                                                                                                         | `@corbits/mcp`                | Pick scopes in the MCP spec's selection order.                                                                                            |
| `mcpServers(config)`                                                                                                            | `@corbits/mcp/sidecar-bundle` | Build tools from stored catalogs over mediated credentials.                                                                               |
| `shapeMcpContent(content)`, `SIDECAR_BUNDLE_ID`                                                                                 | `@corbits/mcp/sidecar-bundle` | Result shaping and the bundle's tool id.                                                                                                  |
| `mountMcpDiscovery(app, opts)`                                                                                                  | `@corbits/mcp/hub`            | Mount `POST /mcp/discover`.                                                                                                               |
| `discoverMcpServer(args)`, `readCredential(opts)`                                                                               | `@corbits/mcp/hub`            | The discovery and credential reads the route uses.                                                                                        |

`McpToolSchema` validates a catalog entry (`McpTool`). Transport and protocol failures throw `McpError`. OAuth discovery failures throw `OAuthDiscoveryError` from `@corbits/oauth-core`.

### Grants

Every call is checked as resource `tool:<name>`. The most specific match wins, and `deny` beats `ask` beats `allow`. `tool:<handle>.<tool>` grants one remote tool and `tool:<handle>.*` covers a whole server. A handle or server name may not contain `.`, and a catalog may not list a tool name twice, so no tool falls under another server's grant.

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

`POST /api/tenants/:tenantId/mcp/discover` with `{ url, credentialId? }` returns `{ data: { serverInfo, tools } }`. `url` must be https; plain-http loopback is refused unless the host sets `allowLoopback: true` for local development. `credentialId` names a tenant credential whose secret is sent as a bearer; the credential's type must be `api_key` or `oauth_token`, and any other type reads as not found. An `oauth_token` credential's secret is its current access token, which [`@corbits/oauth-core`](https://github.com/corbitsdev/corbits-oauth-core)'s refresher renews in place, so nothing here refreshes it, and one past its `expiresAt` or marked `error` reads as not found until it is renewed or the user signs in again; a credential holding `MCP_NO_TOKEN_SENTINEL` from `@corbits/credential-http` sends no `authorization` header. Errors: 400 for a bad body or URL, 404 for an unknown credential or one that is not active or has expired, 422 when the server fails discovery, the secret is not a valid header value, or the request would leave the credential's origin. A 422 carries only this package's own messages and never the upstream HTTP status; any other failure reads as a generic handshake error, so no response or `onError` text quotes the secret. `requireGrant` is the host's own grant middleware for this route.

When a secret is sent, the fetch is pinned to the origin of the credential's provider `apiBaseUrl`; with no credential or a keyless one, to the URL's origin. Redirects are always refused, so the secret never leaves that origin. Each discovery request times out after 30 seconds.

#### Extra origins

Some servers serve MCP on a different origin from the one their credential is issued for. Nothing is allowed off the pinned origin by default. The host lists extra origins per pinned origin in `extraOrigins`, which is passed through to `@corbits/credential-http`:

```ts
mountMcpDiscovery(mcpRoutes, {
  db,
  cipher,
  requireGrant: requireGrant("credential:*", "read"),
  extraOrigins: {
    "https://api.example.com": ["https://mcp.example.net"],
  },
});
```

| Option         | Type                                          | Default |
| -------------- | --------------------------------------------- | ------- |
| `extraOrigins` | `Readonly<Record<string, readonly string[]>>` | `{}`    |

A credential pinned to `https://api.example.com` may then be sent to `https://mcp.example.net`; no other credential can.

`extraOrigins` is host-wide, not per tenant: an entry applies to every tenant's credential pinned to that origin, so list only origins you trust with all of them. `discoverMcpServer` takes the same option. For the sidecar bundle, configure the same allowance on the credential provider the host registers.

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

Each catalog entry becomes a tool named `<handle>.<tool>`, with the remote `inputSchema` passed through and the call proxied to `tools/call`. Text content comes back as text and anything else as JSON; `isError` passes through. `input_required` comes back as an error result whose JSON carries the method, `inputRequests`, and `requestState`. A handle that does not resolve, or a server that fails the handshake, fails only that server's calls.

`handle` is the credential handle the host binds this server's token to. The bundle resolves it from the runtime `credentials` capability and expects an `http` credential, such as the one `@corbits/credential-http`'s MCP provider returns. The package manifest declares the `mcp-server` credential for this.

#### OAuth servers

A host records how a server authenticates in the credential's `metadata.mcp.auth`: `"none"` (the keyless sentinel), `"token"` (a pasted `api_key`) or `"oauth"` (an `oauth_token` login through `@corbits/oauth-core`, using `discoverMcpLoginEntry` and `mcpClientConfig` above). This package does not read the value; it reads the credential's type, so pass the `oauth_token` credential's id as `credentialId`. At run time the credential's provider shapes the handle from the credential's current secret, so a refreshed token reaches running agents without any change to the bundle.

### Grant access

Grant the agent's principal `tool:deepwiki.*` for the whole server, or `tool:deepwiki.<tool>` per tool, with `allow`, `ask` or `deny`.

## Migrating to the 2026 client API

The 2026 client changes the public return contract: `mcpCallTool` returns
`McpToolCallResult`, not only a resolved `McpToolResult`. Callers must narrow
`resultType` before reading `content`, `isError`, or `structuredContent`:

```ts
const result = await mcpCallTool(url, "echo", { text: "hi" }, { session });
if (result.resultType === "input_required") {
  // Fulfill result.inputRequests, then pass this result and the collected
  // inputResponses to mcpContinue(url, result, inputResponses, { session }).
} else if (result.resultType === "task") {
  // Handle the task through the opted-in tasks extension.
} else {
  console.log(result.content);
}
```

`mcpContinue` can return another `input_required` result; always use the latest
pending result for the next retry. Prompt and resource reads also expose their
pending variants. Do not cast a union result to a resolved-only type. This is a
breaking API change: the release containing it must be the next minor release,
with a `!` marker in the breaking-change PR title as required by CONTRIBUTING.

### Protocol regression coverage and limits

The focused regressions in `src/protocol-2026.test.ts` check these requirements:

- [Streamable HTTP backward compatibility](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http#backward-compatibility):
  an HTTP 400 discovery response with an empty, non-JSON, or legacy missing-session
  error body falls back to `initialize`; later requests carry the legacy session.
  Recognized modern errors do not take that fallback. Ordinary HTTP 401/403,
  rate-limit, server, and malformed successful responses remain failures.
- [MRTR client requirements](https://modelcontextprotocol.io/specification/2026-07-28/basic/patterns/mrtr#client-requirements-basic-workflow):
  retries echo only the latest `requestState`, including an empty string, and
  omit it when the latest response omits it. Tests also check fresh request IDs,
  original tool arguments, and the latest input responses across multiple rounds.

These tests and the SDK transport e2e suite are targeted compatibility evidence,
not comprehensive MCP certification. The transport and extension limits listed
above still apply, including no deprecated HTTP+SSE transport or SSE resumption.
This scoped change does not audit or change authorization-error precedence or
OAuth URL handling.

## Upgrading from 0.1

- Existing server configs, stored catalogs and the `mcp-server` credential keep working unchanged.
- `@intx/harness` is a required peer. Import `FetchLike` from it; `@corbits/mcp` no longer exports that type.
- `@intx/db`, `@intx/hub-api`, `drizzle-orm`, `hono` and `@corbits/credential-http` are optional peers. Install them if you use `@corbits/mcp/hub`. `@corbits/credential-http` replaces `@corbits/credential-mcp`.
- Discovery with a credential pins to the credential's provider `apiBaseUrl` origin, not to the requested URL's origin. A credential with a secret whose provider has no `apiBaseUrl` is refused, and a URL on another origin needs `extraOrigins`. No origin is allowed by default.
- `readCredentialSecret` is now `readCredential`, which returns `{ secret, origin? }`. `discoverMcpServer` takes `credential: { secret, origin? }` instead of `secret`.
- `mcpInitialize` returns an `McpSession` (`protocolVersion`, `sessionId?`, `serverInfo?`) and sends `notifications/initialized`. Pass it as `{ session }` to `mcpListTools` and `mcpCallTool`; a stateful server needs it.
- The discovery route refuses plain-http loopback URLs unless `allowLoopback` is set. Handles and server names containing `.`, and catalogs repeating a tool name, are refused. `mcpTools` refuses an empty or repeated server name, and a non-https URL, before any request.
- `@intx/agent` and `@intx/harness` peers are `^0.4.0`.
- Discovery rejects authorization-server metadata whose `issuer` differs from the one the protected resource names.

## License

[LGPL-2.1-only](https://github.com/corbitsdev/corbits-mcp/blob/main/LICENSE)
