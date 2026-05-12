import test from "node:test";
import assert from "node:assert/strict";
import { resolveNoasBunkerUrl } from "../src/noas.js";

test("resolveNoasBunkerUrl returns bunker URL from NOAS connect endpoint", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    assert.equal(url, "https://noas.example.com/api/v1/nip46/connect/alice");
    return {
      ok: true,
      async json() {
        return { bunker_url: "bunker://connect-token" };
      }
    };
  };

  try {
    const bunkerUrl = await resolveNoasBunkerUrl({
      enabled: true,
      baseUrl: "https://noas.example.com",
      username: "alice",
      apiPathPrefix: "/api/v1",
      timeoutMs: 1000
    });
    assert.equal(bunkerUrl, "bunker://connect-token");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("resolveNoasBunkerUrl returns null when NOAS is disabled", async () => {
  const result = await resolveNoasBunkerUrl({ enabled: false });
  assert.equal(result, null);
});
