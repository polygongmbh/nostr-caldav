import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { nip19 } from "nostr-tools";
import { openDb } from "../src/db.js";
import { createBridgeSigner, createNip42AuthSigner } from "../src/signer.js";

function mkDbPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nostr-caldav-signer-"));
  return path.join(dir, "bridge.db");
}

test("createBridgeSigner supports local nsec and signs auth events", async () => {
  const db = openDb(mkDbPath());
  const nsec = nip19.nsecEncode(Uint8Array.from(Buffer.from("11".repeat(32), "hex")));

  const signer = await createBridgeSigner({
    privateKey: nsec,
    bunkerUrl: null,
    relays: ["wss://relay.example"],
    db
  });

  assert.equal(signer.mode, "local");
  assert.equal(signer.enabled, true);

  const authSigner = createNip42AuthSigner(signer);
  assert.ok(authSigner);

  const signed = await authSigner({
    kind: 22242,
    created_at: Math.floor(Date.now() / 1000),
    tags: [["relay", "wss://relay.example"], ["challenge", "abc"]],
    content: ""
  });

  assert.equal(typeof signed.id, "string");
  assert.equal(signed.kind, 22242);

  db.close();
});
