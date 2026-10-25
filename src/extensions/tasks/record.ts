import { type } from "arktype";
import {
  validateTask,
  validateInputRequests,
  validateInputResponses,
} from "../../protocol/index.js";
import type { McpTaskRecord } from "./contracts.js";
const recordShape = type({
  identity: {
    tenantId: "string > 0",
    principalId: "string > 0",
    authorizationContextId: "string > 0",
  },
  task: "object",
  revision: "number.integer >= 0",
  original: { method: "'tools/call'", params: "object" },
  backend: { "[string]": "string" },
  issued: "object",
  answered: "object",
  cancelRequested: "boolean",
  dispatch: "'pending' | 'started'",
});
/** Local persisted envelope boundary; wire payloads use common protocol validators. */
export function validateTaskRecord(value: unknown): McpTaskRecord {
  const result = recordShape(value);
  if (result instanceof type.errors)
    throw new Error(`Invalid persisted task: ${result.summary}`);
  validateTask(result.task, true);
  validateInputRequests(result.issued);
  validateInputResponses(result.answered);
  const record = result as McpTaskRecord;
  for (const key of Object.keys(record.answered))
    if (!Object.hasOwn(record.issued, key))
      throw new Error("Answered input was never issued");
  if (record.task.status === "input_required")
    for (const key of Object.keys(record.task.inputRequests)) {
      if (
        !Object.hasOwn(record.issued, key) ||
        Object.hasOwn(record.answered, key)
      )
        throw new Error("Inconsistent outstanding task input");
    }
  return record;
}
