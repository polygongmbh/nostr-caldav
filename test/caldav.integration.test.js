import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb } from "../src/db.js";
import { issueToVtodo } from "../src/ics.js";
import { processVtodoPut, selectIssuesForSync } from "../src/caldav-core.js";

function mkDbPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nostr-caldav-it-"));
  return path.join(dir, "bridge.db");
}

function seedIssue(db) {
  db.upsertIssueFromNostr(
    {
      id: "a".repeat(64),
      pubkey: "b".repeat(64),
      created_at: 1710000000,
      kind: 1621,
      content: "Body",
      tags: [["subject", "Initial issue"], ["label", "bug"]]
    },
    "wss://relay.example"
  );
  return db.getIssueByEventId("a".repeat(64));
}

test("CalDAV PUT integration updates DB and invokes Nostr publisher", async () => {
  const db = openDb(mkDbPath());
  const published = [];

  const syncService = {
    async publishStatusFromCaldav(issueEventId, status) {
      published.push({ issueEventId, status });
      return { skipped: false, event: { id: "ok", kind: 1631 } };
    }
  };

  const issue = seedIssue(db);
  const initialEtag = issue.caldav_etag;

  const result = await processVtodoPut({
    db,
    syncService,
    uid: issue.caldav_uid,
    ifMatch: initialEtag,
    body: [
      "BEGIN:VCALENDAR",
      "BEGIN:VTODO",
      `UID:${issue.caldav_uid}`,
      "STATUS:COMPLETED",
      "END:VTODO",
      "END:VCALENDAR",
      ""
    ].join("\r\n")
  });

  const updated = db.getIssueByUid(issue.caldav_uid);

  assert.equal(result.status, 204);
  assert.equal(updated.status, "completed");
  assert.notEqual(updated.caldav_etag, initialEtag);
  assert.deepEqual(published, [{ issueEventId: issue.event_id, status: "completed" }]);

  db.close();
});

test("CalDAV PUT integration enforces ETag conflicts", async () => {
  const db = openDb(mkDbPath());
  const issue = seedIssue(db);

  const result = await processVtodoPut({
    db,
    syncService: {
      async publishStatusFromCaldav() {
        throw new Error("should not publish");
      }
    },
    uid: issue.caldav_uid,
    ifMatch: '"stale-etag"',
    body: [
      "BEGIN:VCALENDAR",
      "BEGIN:VTODO",
      `UID:${issue.caldav_uid}`,
      "STATUS:COMPLETED",
      "END:VTODO",
      "END:VCALENDAR",
      ""
    ].join("\r\n")
  });

  assert.equal(result.status, 412);

  db.close();
});

test("Sync token selection and ICS rendering integration", () => {
  const db = openDb(mkDbPath());
  const issue = seedIssue(db);

  const token = db.getSyncToken();
  const allIssues = db.listIssues();

  const deltaNow = selectIssuesForSync({
    currentToken: token,
    requestedToken: token,
    issues: allIssues
  });

  const deltaOld = selectIssuesForSync({
    currentToken: token,
    requestedToken: token - 1,
    issues: allIssues
  });

  assert.equal(deltaNow.length, 0);
  assert.equal(deltaOld.length, 1);

  const ics = issueToVtodo(issue);
  assert.match(ics, /STATUS:NEEDS-ACTION/);
  assert.match(ics, /SUMMARY:Initial issue/);

  db.close();
});
