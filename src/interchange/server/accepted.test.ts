import { expect, test } from "bun:test";
import { Hono } from "hono";
import type { TenantEnv, TenantRow, PrincipalRow } from "@intx/hub-api";
// Test-only import of the installed implementation; product code uses host dispatch.
import {
  createRunRoutes,
  type CreateRunRoutesDeps,
} from "../../../node_modules/@intx/hub-api/dist/routes/runs.js";
import { createMcpServer } from "../../server.js";
import { createInterchangeProviders } from "../server.js";
import { rpc, result } from "../../server/fixtures.js";
import type { McpAuthPolicy } from "../../auth/contracts.js";

/** Fail loudly if the installed route touches a service outside this test's injected surface. */
function service<T extends object>(members: Partial<T> = {}): T {
  return new Proxy(members as T, {
    get(target, key, receiver) {
      if (!Reflect.has(target, key))
        throw new Error(`Unexpected test service access: ${String(key)}`);
      return Reflect.get(target, key, receiver);
    },
  });
}
const identity = {
  tenantId: "tenant",
  principalId: "principal",
  authorizationContextId: "grants",
  scopes: [],
};
const auth: McpAuthPolicy = {
  authenticate: () => identity,
  authorize: () => true,
};
const definition = {
  name: "cancel",
  inputSchema: { type: "object", additionalProperties: false },
};

test("installed hub DELETE route acceptance preserves polling location without claiming cancellation", async () => {
  let cancellations = 0;
  const deps: CreateRunRoutesDeps = {
    db: service(),
    principalKeyStore: service(),
    sessionService: service(),
    sidecarRouter: service(),
    eventCollectors: service(),
    repoStore: null,
    grantStore: service(),
    conditionRegistry: {},
    approvalStore: service(),
    requireGrant: (_resource, action) => async (_context, next) => {
      expect(action).toBe("manage");
      await next();
    },
    workflowLifecycleService: service<
      NonNullable<CreateRunRoutesDeps["workflowLifecycleService"]>
    >({
      async requestCancellation(tenantId, runId, reason) {
        expect([tenantId, runId, reason]).toEqual([
          "tenant",
          "run",
          "Cancellation requested by principal",
        ]);
        cancellations++;
        return "pending";
      },
    }),
  };
  const app = new Hono<TenantEnv>();
  app.use("*", async (context, next) => {
    context.set("tenant", service<TenantRow>({ id: identity.tenantId }));
    context.set(
      "principal",
      service<PrincipalRow>({ id: identity.principalId }),
    );
    await next();
  });
  app.route("/api/tenants/tenant/workflows/runs", createRunRoutes(deps));
  const endpoint = createMcpServer({
    serverInfo: { name: "installed-route", version: "1" },
    auth,
    providers: createInterchangeProviders({
      auth,
      exposures: [
        {
          kind: "operation",
          definition,
          tenantId: "tenant",
          resource: "workflow-run:run",
          action: "manage",
          approve: async () => true,
          method: "DELETE",
          origin: "https://hub.example",
          path: "/api/tenants/tenant/workflows/runs/run",
          dispatch: async (request, boundIdentity) => {
            expect(boundIdentity).toEqual(identity);
            return app.fetch(request);
          },
        },
      ],
    }),
  });
  try {
    const response = await result(
      await endpoint.fetch(
        rpc("tools/call", { name: "cancel", arguments: {} }),
      ),
    );
    expect(cancellations).toBe(1);
    expect(response).toMatchObject({
      result: {
        resultType: "complete",
        structuredContent: {
          status: 202,
          accepted: true,
          location: "/api/tenants/tenant/workflows/runs/run/lifecycle",
        },
      },
    });
    expect(JSON.stringify(response)).not.toContain('"cancelled"');
  } finally {
    await endpoint.close();
  }
});

test("empty accepted signal response is success without terminal-state assertion", async () => {
  const endpoint = createMcpServer({
    serverInfo: { name: "signal", version: "1" },
    auth,
    providers: createInterchangeProviders({
      auth,
      exposures: [
        {
          kind: "operation",
          definition,
          tenantId: "tenant",
          resource: "workflow-run:run",
          action: "manage",
          approve: async () => true,
          method: "POST",
          origin: "https://hub.example",
          path: "/api/tenants/tenant/workflows/run/signals",
          dispatch: async () => new Response(null, { status: 202 }),
        },
      ],
    }),
  });
  try {
    expect(
      await result(
        await endpoint.fetch(
          rpc("tools/call", { name: "cancel", arguments: {} }),
        ),
      ),
    ).toMatchObject({
      result: { structuredContent: { status: 202, accepted: true } },
    });
  } finally {
    await endpoint.close();
  }
});
