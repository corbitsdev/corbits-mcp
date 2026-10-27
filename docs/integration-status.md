# CL-11478 final documentation and package snapshot

Snapshot: 2026-10-25, PR28 commit preparation. All implementation reviews,
including final scoped legacy review, are approved; final QA and commit-preparation verification report 423 passing
unit tests and 2,116 assertions. This is not a 100% conformance claim.

## Current package and compatibility

- Public role factories/contracts are exported and exercised through installed
  tarballs. File-store is explicit `@corbits/mcp/server/task-store` only.
- OAuth-core is an optional peer `^0.3.3` and pinned development dependency 0.3.3.
  Root/login consumers install it explicitly. Neutral client/server installations
  and module graphs exclude optional host stacks. Host/auth fixtures explicitly
  install OAuth-core 0.3.3 and `@intx/harness` 0.5.0 (peer `^0.5.0`).
  `@corbits/credential-http` is an optional peer `^0.1.3`.
- Opt-in server legacy compatibility is implemented for 2025-11-25/06-18/03-26.
  [Legacy deployment](legacy-server.md) documents defaults (1,024 sessions,
  absolute 30-minute TTL), in-memory affinity/restart loss, 10,000 request IDs,
  private initialization authority, March batches and GET405/no resumption.
  Modern remains stateless by default.
- Apps advertisement requires explicit host bridge/support, sandbox/CSP and
  authenticated-bridge commitments, plus presentation. Metadata-only handling
  does not advertise Apps. Actual renderer enforcement remains host-owned.
- Large Skills resources support bounded 16 MiB decoded reads with finite wire
  allowance and independent metadata bounds; authenticated loopback and bounds
  were independently approved, not inferred from artifact smoke counts.

## Exact executable evidence

| Command                                                                            | Exit | Result                                                                                                                                       |
| ---------------------------------------------------------------------------------- | ---- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm exec --yes --package=node@24 -- sh -c 'node --version; bun run test:package'` | 0    | **Node 24.22.1**, Bun 1.4.2; **13 pass / 0 fail**, 39 top-level assertions; one serial build/pack/install gate after legacy fixture addition |
| `npm exec --yes --package=node@24 -- sh -c 'node --version; bun run test:e2e'`     | 0    | **Node 24.22.1**, Bun 1.4.2; **22 pass / 0 fail**, 80 assertions                                                                             |
| `bun run build`                                                                    | 0    | Commit-preparation declaration/package build                                                                                                 |
| `bun run check`                                                                    | 0    | Final QA and commit preparation: typecheck/lint/format and **423 pass / 0 fail**, **2,116 assertions**                                       |

Ordinary npm installation is used without `--omit=peer`, `--force` or
`--legacy-peer-deps`. The 13 current tests cover public export/declarations,
peer-free imports, publisher/loader/task recovery/resource-auth/guarded OAuth
behavior, legacy initialization/capacity/GET405 for three revisions, and both
neutral graphs. They do not substitute for full revision review. Final migration
and legacy artifact evidence is **Bun + Node24**; no final Node26 claim is made.

Final QA supersedes the earlier reconciliation formatting failure. Commit
preparation reran all four gates above serially, including fresh artifact gates
after the test-only cancellation correction. All exited 0; source checks ran
with Bun 1.4.2 (shell Node 26.10.0), and artifact execution used Node 24.22.1.
No product behavior changed during commit preparation.

Director-reported independent approvals cover core F1–F11, authorization,
extensions, Interchange adapters, 16 MiB Skills bounds, and modern/legacy server
behavior. Final scoped legacy evidence includes 50 tests / 319 assertions plus
5 independent tests / 63 assertions, with header and shutdown repairs closed.
These approvals remain scoped, not exhaustive revision certification.

## External follow-ups versus host obligations

**CL11479 (OAuth-core):** stock token-only grant conversion/storage requires a
refresh token; token POST redirect/error handling and extra state/PKCE override
behavior need correction. Guarded MCP login avoids relevant unsafe paths but
stock helpers remain unchanged. Stock hub DCR-only selection and present-but-
unadvertised issuer handling are additional integration limits, distinct from
exact issue acceptance. Resource exchange/refresh propagation exists upstream;
this package's local config omission was fixed.

**CL11480 (credential-http):** the 2026-10-25 snapshot failed npm ERESOLVE on
credential-http 0.1.0, which required harness/types ^0.4.0 against the 0.5.0
baseline. This release's optional peer is `^0.1.3`. `@corbits/credential-http@0.1.3`
accepts `@intx/harness` and `@intx/types` `^0.5.0`. Request+init overrides and
insecure configured schemes were recorded against 0.1.0 and still require
upstream correction. Those optional-host limits do not block the neutral
installation.

Previously reproduced external install of 0.1.0 (exit 1):

```sh
npm install --prefix "$peer_dir" --ignore-scripts --no-audit --no-fund @corbits/credential-http@0.1.0 @intx/agent@0.5.0 @intx/harness@0.5.0 @intx/db@0.5.0 @intx/hub-api@0.5.0 @intx/types@0.5.0 drizzle-orm@0.45.3 hono@4.13.9
```

**Host obligations:** trusted identity/grants, real token verifier/introspection,
encrypted persistence, callback/registration/consent setup, egress/DNS policy,
selected bindings, recoverable executors/storage ownership, legacy affinity,
skill approval/context lifecycle, and actual Apps renderer/bridge security.
These are injected deployment contracts, not missing library implementations.

**Unverified scope:** live production OAuth/DB/listener deployments, distributed
lifecycle durability, actual browser sandbox enforcement and exhaustive
revision-by-clause certification. The [requirement matrix](conformance.md)
retains these qualifications rather than labeling resolved code/tests missing.

## Final narrow documentation corrections

Stored-catalog synchronous construction is correctly attributed to `mcpServers`;
`mcpTools` performs asynchronous live discovery. The stale README OAuth URL
scope disclaimer was removed. Packaged public API/conformance docs explicitly
state verified Skills supported shapes: dynamic manifests declined (permitted
by the pinned specification), exactly one matching text/blob item in a complete
resource read, and no resource MRTR in that adapter. No implementation scope was
expanded. Commit preparation preserves the reviewed product behavior and runs
the repository gates serially.
