import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb } from "../src/db.js";

function mkDbPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nostr-caldav-db-"));
  return path.join(dir, "bridge.db");
}

test("status events update issue state and bump sequence", () => {
  const db = openDb(mkDbPath());

  db.upsertIssueFromNostr(
    {
      id: "1".repeat(64),
      pubkey: "2".repeat(64),
      created_at: 1710000000,
      kind: 1621,
      content: "hello",
      tags: [["subject", "Issue A"]]
    },
    "wss://relay.example"
  );

  const before = db.getIssueByEventId("1".repeat(64));
  const res = db.applyStatusEventFromNostr({
    id: "3".repeat(64),
    kind: 1631,
    created_at: 1710000100,
    tags: [["e", "1".repeat(64)]],
    content: ""
  });

  const after = db.getIssueByEventId("1".repeat(64));

  assert.equal(res.changed, true);
  assert.equal(after.status, "completed");
  assert.equal(after.sequence, before.sequence + 1);

  db.close();
});

test("comment events append content to issue body", () => {
  const db = openDb(mkDbPath());

  db.upsertIssueFromNostr(
    {
      id: "4".repeat(64),
      pubkey: "5".repeat(64),
      created_at: 1710000000,
      kind: 1621,
      content: "original body",
      tags: [["subject", "Issue B"]]
    },
    "wss://relay.example"
  );

  const res = db.applyCommentEventFromNostr({
    id: "6".repeat(64),
    kind: 1622,
    created_at: 1710000150,
    tags: [["e", "4".repeat(64)]],
    content: "new comment"
  });

  const issue = db.getIssueByEventId("4".repeat(64));

  assert.equal(res.changed, true);
  assert.match(issue.body, /original body/);
  assert.match(issue.body, /\[comment:66666666\] new comment/);

  db.close();
});

test("issues persist channel and mention tags and support channel filtering", () => {
  const db = openDb(mkDbPath());
  const eventId = "7".repeat(64);
  const author = "8".repeat(64);
  const mentioned = "9".repeat(64);

  db.upsertIssueFromNostr(
    {
      id: eventId,
      pubkey: author,
      created_at: 1710000000,
      kind: 1621,
      content: "body",
      tags: [
        ["subject", "Issue C"],
        ["t", "ops"],
        ["t", "backend"],
        ["p", mentioned]
      ]
    },
    "wss://relay.example"
  );

  const issue = db.getIssueByEventId(eventId);
  assert.deepEqual(JSON.parse(issue.channel_tags), ["ops", "backend"]);
  assert.deepEqual(JSON.parse(issue.mention_pubkeys), [mentioned]);
  assert.deepEqual(db.listDistinctChannelTags(), ["backend", "ops"]);

  const filtered = db.listIssuesFiltered({ tags: ["ops"] });
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].event_id, eventId);

  db.close();
});
