import type {
  ElicitRequestParams,
  ElicitRequestFormParams,
  ElicitRequestURLParams,
  ElicitResult,
  InputRequests,
  InputResponses,
} from "../protocol/index.js";
import {
  validateInstance,
  validateInputRequests,
  validateInputResponses,
} from "../protocol/index.js";

/** Request-aware host semantics shared by direct and durable task input.
 * Wire shape validation remains owned by the common protocol module.
 */
export function validateElicitationResponse(
  request: ElicitRequestParams,
  response: InputResponses[string],
): void {
  validateInputResponses({ response });
  if (request.mode === "url" && response.content !== undefined)
    throw new Error("URL elicitation cannot return form content");
  if (response.action !== "accept" && response.content !== undefined)
    throw new Error("Non-accept elicitation must omit content");
  if (request.mode !== "url" && response.action === "accept")
    validateInstance(request.requestedSchema, response.content ?? {});
}

export interface McpElicitationHost {
  form?(
    request: ElicitRequestFormParams,
    signal?: AbortSignal,
  ): Promise<ElicitResult>;
  /** Host presents URL and obtains explicit user consent. Opening a URL is not acceptance. */
  url?(
    request: ElicitRequestURLParams,
    signal?: AbortSignal,
  ): Promise<ElicitResult>;
}
/** Input has already passed the common wire validators. No sampling/roots capability implied. */
export function createElicitationRuntime(host: McpElicitationHost) {
  return {
    capabilities: {
      ...(host.form ? { form: {} } : {}),
      ...(host.url ? { url: {} } : {}),
    },
    async respond(
      requests: InputRequests,
      signal?: AbortSignal,
    ): Promise<InputResponses> {
      validateInputRequests(requests);
      const responses: InputResponses = {};
      for (const [key, request] of Object.entries(requests)) {
        signal?.throwIfAborted();
        if (request.method !== "elicitation/create")
          throw new Error(`Unsupported host input: ${request.method}`);
        const params = request.params;
        let response: ElicitResult;
        if (params.mode === "url") {
          const url = new URL(params.url);
          if (url.protocol !== "https:" || url.username || url.password)
            throw new Error("Unsafe elicitation URL");
          if (!host.url) throw new Error("URL elicitation host unavailable");
          response = await host.url(structuredClone(params), signal);
        } else {
          if (!host.form) throw new Error("Form elicitation host unavailable");
          response = await host.form(structuredClone(params), signal);
        }
        validateElicitationResponse(params, response);
        signal?.throwIfAborted();
        Object.defineProperty(responses, key, {
          value: structuredClone(response),
          enumerable: true,
          configurable: true,
          writable: true,
        });
      }
      return responses;
    },
  };
}
