import test from "node:test";
import assert from "node:assert/strict";
import { createNoasAuthProvider } from "../src/noas-auth.js";

// parseHandle is internal — test it via authenticate() with a controlled NOAS stub.
// We also test it indirectly: a correct parse reaches the NOAS sign-in call with the
// right username/domain, and the relay is stripped before hitting NOAS.

function makeStubFetch({ publicKey, encryptedKey }) {
  return async (_url, opts) => {
    const body = JSON.parse(opts.body);
    return {
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify({
          success: true,
          public_key: publicKey,
          private_key_encrypted: encryptedKey,
          relays: ["wss://relay.example"]
        });
      }
    };
  };
}

// A real NIP-49 encrypted key for "aaaa..." private key encrypted with password "test":
// We use a minimal stub that skips real NIP-49 by testing the parse path only.
// For pure parse tests we verify the NOAS fetch receives the right username/domain.

test("parseHandle: plain username@domain has no relay filter", async () => {
  const seen = [];
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (url, opts) => {
    seen.push({ url, body: JSON.parse(opts.body) });
    return { ok: false, status: 401, async text() { return JSON.stringify({ success: false, error: "bad creds" }); } };
  };

  try {
    const provider = createNoasAuthProvider({
      enabled: true,
      caldavAuthEnabled: true,
      baseUrl: "https://noas.example.com"
    });

    await provider.authenticate("ryan@polygon.gmbh", "wrongpassword").catch(() => {});

    assert.equal(seen.length, 1);
    assert.equal(seen[0].body.username, "ryan");
    assert.ok(!seen[0].body.relay, "relay should not be in the NOAS POST body");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("parseHandle: username@domain@relay sends only username+domain to NOAS", async () => {
  const seen = [];
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (url, opts) => {
    seen.push({ url, body: JSON.parse(opts.body) });
    return { ok: false, status: 401, async text() { return JSON.stringify({ success: false, error: "bad creds" }); } };
  };

  try {
    const provider = createNoasAuthProvider({
      enabled: true,
      caldavAuthEnabled: true,
      baseUrl: "https://noas.example.com"
    });

    await provider.authenticate("ryan@polygon.gmbh@test.nostr.melonion.me", "wrongpassword").catch(() => {});

    assert.equal(seen.length, 1, "Should make exactly one NOAS request");
    assert.equal(seen[0].body.username, "ryan");
    // The relay must NOT be forwarded to NOAS — only username+domain
    assert.ok(!seen[0].url.includes("melonion"), "relay must not appear in the NOAS request URL");
    assert.ok(!seen[0].body.relay, "relay must not be in the NOAS POST body");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("parseHandle: relay scheme and trailing slash are normalized", async () => {
  const seen = [];
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (url, opts) => {
    seen.push({ url, body: JSON.parse(opts.body) });
    return { ok: false, status: 401, async text() { return JSON.stringify({ success: false, error: "bad" }); } };
  };

  try {
    const provider = createNoasAuthProvider({
      enabled: true,
      caldavAuthEnabled: true,
      baseUrl: "https://noas.example.com"
    });

    // Two sign-ins with equivalent relay specs — both should reach NOAS (will fail auth),
    // but importantly neither relay variant should affect the NOAS URL.
    await provider.authenticate("ryan@polygon.gmbh@wss://relay.example.com/", "x").catch(() => {});
    await provider.authenticate("ryan@polygon.gmbh@relay.example.com", "x").catch(() => {});

    assert.equal(seen.length, 2);
    // The NOAS endpoint URL should be the same for both (baseUrl-based)
    assert.equal(seen[0].url, seen[1].url);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("parseHandle: throws on malformed handle", async () => {
  const provider = createNoasAuthProvider({
    enabled: true,
    caldavAuthEnabled: true,
    baseUrl: "https://noas.example.com"
  });

  await assert.rejects(
    () => provider.authenticate("justusername", "pass"),
    /Expected NOAS handle/
  );

  await assert.rejects(
    () => provider.authenticate("@nodomain", "pass"),
    /Expected NOAS handle/
  );
});

test("authenticate returns null when provider is disabled", async () => {
  const provider = createNoasAuthProvider({ enabled: false, caldavAuthEnabled: false });
  const result = await provider.authenticate("ryan@example.com", "pass");
  assert.equal(result, null);
});
