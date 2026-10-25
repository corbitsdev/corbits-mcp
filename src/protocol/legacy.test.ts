import { expect, test } from "bun:test";
import { validateLegacyInitialize } from "./legacy.js";

test("legacy initialization validates lifecycle fields and retains unknown capability metadata", () => {
  const valid = {
    protocolVersion: "2025-06-18",
    capabilities: { experimental: { vendor: {} } },
    clientInfo: { name: "client", version: "1" },
  };
  expect(validateLegacyInitialize(valid)).toEqual(valid);
  for (const invalid of [
    {},
    { ...valid, protocolVersion: 12 },
    { ...valid, capabilities: [] },
    { ...valid, capabilities: null },
    { ...valid, clientInfo: { name: "client" } },
  ])
    expect(() => validateLegacyInitialize(invalid)).toThrow();
});
