import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb } from "../src/db.js";
import { createCaldavServer } from "../src/caldav.js";

function mkDbPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nostr-caldav-debug-"));
  return path.join(dir, "bridge.db");
}

function authHeader(username, password) {
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
}

test("debug recent-writes endpoint requires auth and returns sync log rows", async () => {
  const db = openDb(mkDbPath());
  db.logSync({
    direction: "caldav_to_nostr",
    eventId: "e".repeat(64),
    action: "published_kind_1631"
  });

  const app = createCaldavServer({
    db,
    caldavConfig: {
      baseUrl: "http://127.0.0.1",
      username: "user",
      password: "password",
      principals: [{ username: "user", password: "password", pubkeys: [], calendars: [] }]
    },
    syncService: {
      async publishStatusFromCaldav() {
        return { skipped: true };
      }
    },
    trackedPubkeys: []
  });

  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const { port } = server.address();

  const unauth = await fetch(`http://127.0.0.1:${port}/debug/recent-writes`);
  assert.equal(unauth.status, 401);

  const res = await fetch(`http://127.0.0.1:${port}/debug/recent-writes?limit=5`, {
    headers: {
      Authorization: authHeader("user", "password")
    }
  });

  assert.equal(res.status, 200);
  const payload = await res.json();
  assert.equal(payload.count, 1);
  assert.equal(payload.rows[0].direction, "caldav_to_nostr");
  assert.equal(payload.rows[0].action, "published_kind_1631");

  await new Promise((resolve) => server.close(resolve));
  db.close();
});
