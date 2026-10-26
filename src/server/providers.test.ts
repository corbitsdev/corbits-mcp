import { expect, test } from "bun:test";
import { createMcpServer } from "../server.js";
import { rpc, result } from "./fixtures.js";
import type { McpProvider } from "./contracts.js";

const provider = (handle: McpProvider["handle"]): McpProvider => ({
  resource: "fixture",
  action: "read",
  handle,
});
const info = { name: "providers", version: "1" };

test("prompts, resources, templates and completion execute through shared boundaries", async () => {
  const server = createMcpServer({
    serverInfo: info,
    auth: "public",
    providers: {
      "prompts/list": provider(() => ({ prompts: [{ name: "greet" }] })),
      "prompts/get": provider(() => ({
        messages: [{ role: "user", content: { type: "text", text: "Hello" } }],
      })),
      "resources/list": provider(() => ({
        resources: [{ name: "file", uri: "test:///file" }],
      })),
      "resources/templates/list": provider(() => ({
        resourceTemplates: [{ name: "files", uriTemplate: "test:///{file}" }],
      })),
      "resources/read": provider((params) => ({
        contents: [{ uri: params.uri, text: "contents" }],
      })),
      "completion/complete": provider(() => ({
        completion: { values: ["hello"] },
      })),
    },
  });
  for (const [method, params, field] of [
    ["prompts/list", {}, "prompts"],
    ["prompts/get", { name: "greet" }, "messages"],
    ["resources/list", {}, "resources"],
    ["resources/templates/list", {}, "resourceTemplates"],
    ["resources/read", { uri: "test:///file" }, "contents"],
    [
      "completion/complete",
      {
        ref: { type: "ref/prompt", name: "greet" },
        argument: { name: "greeting", value: "he" },
      },
      "completion",
    ],
  ] as const)
    expect(
      await result(await server.fetch(rpc(method, params))),
    ).toHaveProperty(`result.${field}`);
  await server.close();
});

test("MRTR requires client capability and passes continuation to selected provider", async () => {
  const server = createMcpServer({
    serverInfo: info,
    auth: "public",
    providers: {
      "tools/call": provider((params) =>
        params.inputResponses
          ? { content: [{ type: "text", text: "resumed" }] }
          : {
              resultType: "input_required",
              requestState: "host-bound-state",
              inputRequests: {
                question: {
                  method: "elicitation/create",
                  params: {
                    mode: "form",
                    message: "Choose",
                    requestedSchema: {
                      type: "object",
                      properties: { answer: { type: "string" } },
                    },
                  },
                },
              },
            },
      ),
    },
  });
  expect(
    await result(await server.fetch(rpc("tools/call", { name: "ask" }))),
  ).toHaveProperty("error");
  const _meta = {
    "io.modelcontextprotocol/clientCapabilities": { elicitation: { form: {} } },
  };
  expect(
    await result(await server.fetch(rpc("tools/call", { name: "ask", _meta }))),
  ).toMatchObject({
    result: { resultType: "input_required", requestState: "host-bound-state" },
  });
  expect(
    await result(
      await server.fetch(
        rpc("tools/call", {
          name: "ask",
          _meta,
          requestState: "host-bound-state",
          inputResponses: {
            question: { action: "accept", content: { answer: "yes" } },
          },
        }),
      ),
    ),
  ).toMatchObject({ result: { content: [{ text: "resumed" }] } });
  await server.close();
});

test("subscription provider cannot publish notifications outside requested filter", async () => {
  const server = createMcpServer({
    serverInfo: info,
    auth: "public",
    providers: {
      "subscriptions/listen": {
        acceptSubscription: () => ({ toolsListChanged: true }),
        ...provider((_params, context) => {
          context.notify("notifications/tools/list_changed", {});
          context.notify("notifications/resources/updated", {
            uri: "test:///secret",
          });
          return {};
        }),
      },
    },
  });
  const response = await server.fetch(
    rpc("subscriptions/listen", { notifications: { toolsListChanged: true } }),
  );
  const text = await response.text();
  expect(text).toContain("notifications/tools/list_changed");
  expect(text).not.toContain("test:///secret");
  await server.close();
});
