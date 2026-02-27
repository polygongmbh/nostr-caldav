import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb } from "../src/db.js";
import { issueToVtodo } from "../src/ics.js";
import { processVtodoCreate, processVtodoPut, runReportQuery, selectIssuesForSync } from "../src/caldav-core.js";

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

test("CalDAV PUT integration accepts weak If-Match", async () => {
  const db = openDb(mkDbPath());
  const issue = seedIssue(db);

  const result = await processVtodoPut({
    db,
    syncService: {
      async publishStatusFromCaldav() {
        return { skipped: false, event: { id: "ok", kind: 1631 } };
      }
    },
    uid: issue.caldav_uid,
    ifMatch: `W/${issue.caldav_etag}`,
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

  assert.equal(result.status, 204);
  assert.equal(db.getIssueByUid(issue.caldav_uid).status, "completed");
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

test("calendar-query filters by SUMMARY text-match", () => {
  const db = openDb(mkDbPath());
  seedIssue(db);

  db.upsertIssueFromNostr(
    {
      id: "c".repeat(64),
      pubkey: "d".repeat(64),
      created_at: 1710000300,
      kind: 1621,
      content: "Another body",
      tags: [["subject", "Different task"], ["label", "chore"]]
    },
    "wss://relay.example"
  );

  const report = runReportQuery({
    issues: db.listIssues(),
    syncToken: db.getSyncToken(),
    reportBody: `<?xml version="1.0" encoding="UTF-8"?>
<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop><d:getetag/><c:calendar-data/></d:prop>
  <c:filter>
    <c:comp-filter name="VCALENDAR">
      <c:comp-filter name="VTODO">
        <c:prop-filter name="SUMMARY">
          <c:text-match match-type="contains">Initial</c:text-match>
        </c:prop-filter>
      </c:comp-filter>
    </c:comp-filter>
  </c:filter>
</c:calendar-query>`
  });

  assert.equal(report.type, "calendar-query");
  assert.equal(report.results.length, 1);
  assert.equal(report.results[0].issue.subject, "Initial issue");

  db.close();
});

test("CalDAV PUT create integration publishes kind 1621 and stores UID mapping", async () => {
  const db = openDb(mkDbPath());
  const published = [];

  const syncService = {
    async createIssueFromCaldav({ uid, summary, description, labels, status }) {
      published.push({ uid, summary, description, labels, status });
      db.upsertIssueFromNostr(
        {
          id: "e".repeat(64),
          pubkey: "f".repeat(64),
          created_at: 1710000600,
          kind: 1621,
          content: description,
          tags: [["subject", summary], ...labels.map((l) => ["label", l])]
        },
        "caldav-bridge"
      );
      db.setIssueUidFromCaldav({ eventId: "e".repeat(64), uid });
      return { skipped: false, event: { id: "e".repeat(64), kind: 1621 } };
    }
  };

  const uid = "reminders-new-1@local";
  const result = await processVtodoCreate({
    db,
    syncService,
    uid,
    body: [
      "BEGIN:VCALENDAR",
      "BEGIN:VTODO",
      `UID:${uid}`,
      "SUMMARY:Created in Reminders",
      "DESCRIPTION:hello",
      "CATEGORIES:home,errands",
      "STATUS:NEEDS-ACTION",
      "END:VTODO",
      "END:VCALENDAR",
      ""
    ].join("\r\n")
  });

  const issue = db.getIssueByUid(uid);
  assert.equal(result.status, 201);
  assert.ok(issue);
  assert.equal(issue.subject, "Created in Reminders");
  assert.equal(published.length, 1);
  assert.deepEqual(published[0].labels, ["home", "errands"]);

  db.close();
});
