# Opt-in legacy Streamable HTTP server

`createMcpServer` is modern/stateless by default. To enable identity-bound 2025
sessions, configure the public `legacy` option:

```ts
import { createMcpServer } from "@corbits/mcp/server";

const server = createMcpServer({
  serverInfo: { name: "example", version: "1" },
  auth: "public", // For private servers, supply an authenticating/authorizing policy.
  legacy: {
    versions: ["2025-11-25", "2025-06-18", "2025-03-26"],
    maxSessions: 1024,
    sessionTtlMs: 30 * 60_000,
  },
});
```

Omitting individual legacy settings uses those defaults. Omitting `legacy`
entirely does not create legacy sessions. Modern requests stay stateless even
when legacy support is enabled. Public types `McpLegacyOptions` and
`McpLegacyRevision` are available through the server entry.

## Deployment and compatibility limits

- Sessions live in memory in one server instance. Route all requests for a
  session to that instance (affinity); restart loses sessions and clients must
  initialize again. This is not a distributed session store.
- The default absolute lifetime is 30 minutes, not extended by traffic. Capacity
  defaults to 1,024 sessions; exhaustion refuses a new initialization.
- A session permits at most 10,000 unique request IDs (including initialization).
  IDs cannot be reused; initialize a new session when the limit is reached.
- Private initialization requires authorization for resource `mcp:server`, action
  `initialize`. Sessions bind tenant/principal/authorization context, and calls
  recheck authorization. Session possession is not a grant.
- Only 2025-03-26 accepts supported JSON-RPC request/notification batches.
  Initialization cannot be batched; later revisions reject batches.
- GET returns 405. Removed HTTP+SSE, independent GET streams and resumption are
  not implemented. Legacy cancellation uses the session-scoped explicit
  notification, not modern stream-close cancellation semantics.
- No translation of modern tasks/skills/MRTR into older extension generations is
  implied. The legacy shim exposes only supported legacy methods/results.

## Evidence scope

`src/server/legacy.test.ts` covers actual SDK clients over loopback HTTP for all
three revisions, session lifecycle/bounds, identity/authorization, March batches,
malformed envelopes, result projection and cancellation. Legacy review now has
final scoped approval, reported by the director: 50 tests / 319 assertions plus
5 independent tests / 63 assertions. Both header and shutdown repairs are closed.
Final reconciled QA remains pending; this approval is not universal revision
certification.

`e2e/fixtures/packed-legacy.mjs` checks installed public factory options for all
three revisions, initialization/session headers, configured capacity and GET405
under Bun and Node24. It is a public-artifact smoke, not a substitute for the
full server or independent revision review.
