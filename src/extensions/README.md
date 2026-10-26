# Extension runtimes

These modules consume the shared `protocol/index` wire contracts. They do not
register HTTP handlers, grant tools, authenticate callers, or enable transport
capabilities. Adapters register the corresponding methods and advertise only
services actually installed. Stable upstream extensions use ordinary API names;
wire identifiers and revisions come from the shared pinned maturity registry.
No experimental `allowed-tools` interpreter is implemented: the field is preserved
as author data and **never grants permissions**.

## Skills

`createSkillPublisher([{uri, files}])` builds immutable in-memory publications.
`list`, `get`, `read`, and `directoryRead` return complete MCP results. Register
these under `skills/list`, `skills/get`, `resources/read`, and optionally
`resources/directory/read`. Also advertise `resources`. Authorize catalog and
file access under the same host identity. Publication is a complete snapshot,
including nested files, not filesystem discovery or a live directory watcher.
No URI authority is resolved through DNS. Missing resources use error code -32602.

`createSkillLoader(source, host?)` provides `hold`, `get`, `verify`, `activate`,
and `clear`. `hold` accepts a previously validated list entry; `get` confirms an
explicit URI even if absent from a listing. The source is an origin-pinned,
credential-mediated adapter. Its `read(origin, uri, maxBytes)` must enforce the
byte limit **while receiving the response**, decode one matching text/blob
resource into raw bytes, and reject input-required or mismatched resources.
The loader independently checks size, digest, frontmatter, directory containment,
and the held manifest before exposing bytes. Reads and caching are lazy.

Limits: 512 resources and 16 MiB aggregate bytes, inclusive. Frontmatter is JSON-
compatible YAML, with no aliases, at most 32 levels and 100,000 AST nodes. Unknown
frontmatter fields are preserved. Dynamic manifests are explicitly declined:
there is no stable content to which approval could bind. A listing is not an
activation, and a generic resource read is never activation.

Origins contain host-assigned `serverId`, `tenantId`, `principalId`, and
`authorizationContextId`; none may be inferred from serverInfo or model arguments.
Identity includes the full skill URI, not its name. Show this origin/path to both
user and model; do not allow name collisions to shadow local or other-origin
skills. Cache keys and approvals include this identity and manifest fingerprint.
The bounded in-memory cache owns copied bytes and rehashes on access. `clear`
revokes approvals/leases and removes cache data when the server is removed.
There is no disk skill cache or filesystem materialization. A host adding one
must exclude all filesystem skill discovery paths and preserve MCP provenance
across restart, with immutable host-only writes or rehashing on every read.

Activation requires `McpSkillHostPolicy`. `approve` returns an identity- and
fingerprint-bound explicit user receipt. Execution consent is separate from
context admission, never broad grant widening. Changed manifest sets revoke
receipts and live execution; unlisted, size/digest or frontmatter failures revoke
the held entry and require refresh. Nested SKILL.md files are inert supporting
bytes until separately activated and explicitly approved.

`openActingWindow(held, receipt, guards)` must install
`guards.assertExecutionApproved` on **every host code-execution tool**, including
arbitrary commands suggested in the body, before `admit` puts untrusted,
origin-tagged content into context. It must also preserve normal authorization.
No field, hook, or `allowed-tools` declaration may widen permissions. All
skill-driven resource reads must use the originating server. Cross-origin reads
are not provided here; a host implementing them needs explicit per-call consent
naming both servers. The host must prevent bypass through generic resource tools.

`SkillLease.release()` calls `removeContext` before `close`; the host must not
return from removal until the skill has left model context. A failed removal
keeps the gate installed. A digest is only consistency evidence, never a trust
anchor or proof of safe instructions. Pure `verify` does not claim host activation.

## Tasks

`createTaskRuntime({store, executor, authorizeInput, validateTask?, now?})` exposes
`create`, `get`, `transition`, `submitInput`, `cancel`, and `recover`. Identities
are host-bound tenant/principal/authorization-context triples. Only `tools/call`
can create tasks; the server checks per-request extension capability before
calling it. Shared wire validation is the default; the optional validation hook
may add host constraints. `get` returns a flat complete detailed task, and create
returns the shared flat task handle. Updates and cancellation acknowledge complete
empty results, not optimistic completion.

A durable create precedes dispatch. Executor `start` must use task ID as correlation
or idempotency key. Records persist original request, backend correlations, revision,
issued/answered input keys, dispatch state and cancellation intent. Do not place
bearer tokens/secrets in records. The executor must persist backend correlation
through `transition` and implement restart reconciliation. Persisted intent is not
exactly-once dispatch: never replay ambiguous non-idempotent effects blindly.
Input authorization must resolve the actual pending approval route or workflow
signal, not turn a submitted form into blanket approval. Unknown/answered keys
are ignored, partial answers remain pending, and keys cannot denote new requests.
`recover` records a JSON-RPC failure when backend recovery is unavailable.
Cancellation remains cooperative; a successful ack does not promise work stopped.

`pollTask` persists its ID first, honors server intervals, deduplicates input keys,
and requires a host input handler. Abort stops local polling, not the remote task;
call the transport's `tasks/cancel` explicitly when cancellation is intended.
Default polling bound is 10,000 polls; exhausting it leaves the durable task intact.

Import `createFileTaskStore` explicitly from `tasks/file-store`; it is deliberately
absent from the neutral index. This opt-in reference adapter supports one writer
on a local filesystem, a private 0700 directory, 0600 files, exclusive writer lock,
fsynced atomic snapshots, CAS and expiry. Snapshot bound is 16 MiB. Supply
`validateTaskRecord` for restart validation. Close before reopening. A crash leaves
the lock: an operator must establish that its process is dead before removing it.
No automatic lock stealing or multi-host/distributed-filesystem claim is made.
Production multi-replica hosts supply their own atomic durable store and recoverable
executor. In-memory storage does not satisfy the advertisement gate.

## Apps and elicitation

`isToolVisibleToModel` filters app-only tools from model catalogs.
`assertAppToolCall` enforces app visibility and same-server connection;
`createAppHostBridge` rechecks host authorization before dispatch.
`getAppHostRequirements` records requested CSP/permissions/domain plus mandatory
sandbox, authenticated message bridge and lifecycle obligations. It is **not a
renderer, HTML validator, CSP header generator, or sandbox implementation**.
Only a real mounted host satisfying these obligations can advertise Apps support.
Tool-result private metadata belongs to the app, never model context. The host
must verify message source/origin, await initialization, enforce restrictive CSP
without undeclared domains, and obtain navigation/permission consent.

`createElicitationRuntime` exposes only installed form/URL callbacks. It uses shared
wire/schema validation, rejects absent services, validates accepted form data,
and never converts opening a URL into acceptance. URL navigation policy requires
HTTPS without embedded credentials. Sampling and roots remain unsupported. Host
callbacks must present trustworthy origin and consent UI; they are not generated
by transport negotiation flags.

### Review hardening

All four Skills publisher methods emit `ttlMs: 0` and `cacheScope: "private"`.
This conservative policy permits no freshness reuse and no shared/public cache
assumption, even though the publisher owns immutable byte snapshots. Hosts must
still authorize each request; manifest-verified loader caching is separate.

A source read/stream/decoding rejection revokes the current held generation just
like a local integrity mismatch. Refresh and explicit approval are required before
activation resumes. Revocation is irreversible for existing held entries and
leases: clearing the loader or changing A to B and back to A never revives an old
acting window. Hosts must continue invoking the supplied live execution guard.

File-store close is a one-shot operation shared by concurrent callers. It stops
accepting new operations, drains previously accepted operations, and releases its
lock once. Calling a stale store's close again cannot remove a successor's lock.

Direct and task elicitation share request-aware response checks: URL-mode responses
must omit content; declined/cancelled responses must omit content; accepted form
responses must satisfy the requested schema. Invalid task input is rejected before
any durable mutation or executor dispatch.
