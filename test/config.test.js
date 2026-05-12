import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../src/config.js";

function writeTempConfig(contents) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nostr-caldav-config-"));
  const file = path.join(dir, "config.yaml");
  fs.writeFileSync(file, contents, "utf8");
  return file;
}

test("loadConfig parses principals and pubkeys", () => {
  const pathToConfig = writeTempConfig(`
nostr:
  relays: ["wss://relay.example"]
  follow_pubkeys: ["${"ab".repeat(32)}"]
caldav:
  username: "user"
  password: "pass"
  principals:
    - username: "u1"
      password: "p1"
      pubkeys: ["${"cd".repeat(32)}"]
      calendars:
        - id: "bugs"
          labels: ["bug"]
`);

  const cfg = loadConfig(pathToConfig);
  assert.equal(cfg.caldav.principals.length, 1);
  assert.equal(cfg.caldav.principals[0].username, "u1");
  assert.equal(cfg.caldav.principals[0].calendars[0].id, "bugs");
  assert.equal(cfg.nostr.followPubkeys.length, 1);
});

test("loadConfig parses optional NOAS signer config", () => {
  const pathToConfig = writeTempConfig(`
nostr:
  relays: ["wss://relay.example"]
  follow_pubkeys: ["${"ab".repeat(32)}"]
  noas:
    enabled: true
    base_url: "https://noas.example.com"
    username: "alice"
    api_path_prefix: "/api/v1"
    timeout_ms: 9000
`);

  const cfg = loadConfig(pathToConfig);
  assert.equal(cfg.nostr.noas.enabled, true);
  assert.equal(cfg.nostr.noas.baseUrl, "https://noas.example.com");
  assert.equal(cfg.nostr.noas.username, "alice");
  assert.equal(cfg.nostr.noas.apiPathPrefix, "/api/v1");
  assert.equal(cfg.nostr.noas.timeoutMs, 9000);
});
