import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb } from "../src/db.js";
import { calendarEventToVevent } from "../src/ics.js";
import { runReportQuery } from "../src/caldav-core.js";
import { listCalendarEventsForCalendar, calendarEventVisibleToPrincipal } from "../src/caldav-calendars.js";

function mkDbPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nostr-caldav-cal-"));
  return path.join(dir, "bridge.db");
}

const PUBKEY = "a".repeat(64);

function makeTimedEvent(overrides = {}) {
  return {
    id: "e".repeat(64),
    pubkey: PUBKEY,
    kind: 31923,
    created_at: 1710000000,
    content: "Annual planning session",
    tags: [
      ["d", "planning-2026"],
      ["title", "Q1 Planning"],
      ["start", "1751400000"],
      ["end", "1751403600"],
      ["location", "Conference Room A"],
      ["t", "work"],
      ["t", "planning"]
    ],
    ...overrides
  };
}

function makeDateEvent(overrides = {}) {
  return {
    id: "f".repeat(64),
    pubkey: PUBKEY,
    kind: 31922,
    created_at: 1710000000,
    content: "Company holiday",
    tags: [
      ["d", "holiday-2026-07-04"],
      ["title", "Independence Day"],
      ["start", "2026-07-04"],
      ["end", "2026-07-05"],
      ["t", "holiday"]
    ],
    ...overrides
  };
}

// ── DB: upsertCalendarEventFromNostr ──────────────────────────────────────────

test("upsertCalendarEventFromNostr stores a timed event", () => {
  const db = openDb(mkDbPath());
  const event = makeTimedEvent();

  db.upsertCalendarEventFromNostr(event, "wss://relay.example");
  const stored = db.getCalendarEventByUid(`${event.id}@nostr-calendar`);

  assert.ok(stored, "calendar event should be stored");
  assert.equal(stored.title, "Q1 Planning");
  assert.equal(stored.description, "Annual planning session");
  assert.equal(stored.start_at, 1751400000);
  assert.equal(stored.end_at, 1751403600);
  assert.equal(stored.location, "Conference Room A");
  assert.equal(stored.is_all_day, 0);
  assert.equal(stored.d_tag, "planning-2026");
  assert.equal(stored.kind, 31923);
  assert.match(stored.labels, /work/);
  assert.match(stored.labels, /planning/);

  db.close();
});

test("upsertCalendarEventFromNostr stores an all-day event", () => {
  const db = openDb(mkDbPath());
  const event = makeDateEvent();

  db.upsertCalendarEventFromNostr(event, "wss://relay.example");
  const stored = db.getCalendarEventByUid(`${event.id}@nostr-calendar`);

  assert.ok(stored);
  assert.equal(stored.title, "Independence Day");
  assert.equal(stored.is_all_day, 1);
  assert.equal(stored.start_date, "2026-07-04");
  assert.equal(stored.end_date, "2026-07-05");
  assert.equal(stored.start_at, null);

  db.close();
});

test("upsertCalendarEventFromNostr updates addressable event when newer", () => {
  const db = openDb(mkDbPath());
  const event = makeTimedEvent();

  db.upsertCalendarEventFromNostr(event, "wss://relay.example");
  const first = db.getCalendarEventByUid(`${event.id}@nostr-calendar`);

  const updatedEvent = makeTimedEvent({
    id: "9".repeat(64),
    created_at: 1710000999,
    content: "Updated content",
    tags: [
      ["d", "planning-2026"],
      ["title", "Q1 Planning (Updated)"],
      ["start", "1751400000"],
      ["end", "1751403600"]
    ]
  });

  db.upsertCalendarEventFromNostr(updatedEvent, "wss://relay.example");
  const second = db.getCalendarEventByUid(first.caldav_uid);

  assert.equal(second.caldav_uid, first.caldav_uid, "caldav_uid should be preserved on update");
  assert.equal(second.title, "Q1 Planning (Updated)");
  assert.equal(second.description, "Updated content");
  assert.ok(second.sequence > first.sequence, "sequence should increment on update");

  db.close();
});

test("upsertCalendarEventFromNostr rejects stale updates", () => {
  const db = openDb(mkDbPath());
  const event = makeTimedEvent({ created_at: 1710001000 });

  db.upsertCalendarEventFromNostr(event, "wss://relay.example");
  const first = db.getCalendarEventByUid(`${event.id}@nostr-calendar`);

  const stale = makeTimedEvent({
    id: "7".repeat(64),
    created_at: 999,
    content: "stale content",
    tags: [["d", "planning-2026"], ["title", "Stale"]]
  });

  const result = db.upsertCalendarEventFromNostr(stale, "wss://relay.example");
  assert.equal(result.changed, false);
  assert.equal(result.reason, "stale_calendar_event");

  const stored = db.getCalendarEventByUid(first.caldav_uid);
  assert.equal(stored.title, "Q1 Planning", "title should be unchanged after stale update");

  db.close();
});

test("upsertCalendarEventFromNostr bumps sync token", () => {
  const db = openDb(mkDbPath());
  const tokenBefore = db.getSyncToken();

  db.upsertCalendarEventFromNostr(makeTimedEvent(), "wss://relay.example");

  assert.ok(db.getSyncToken() > tokenBefore);
  db.close();
});

test("listCalendarEventsFiltered filters by pubkey", () => {
  const db = openDb(mkDbPath());
  const otherPubkey = "b".repeat(64);

  db.upsertCalendarEventFromNostr(makeTimedEvent(), "wss://relay.example");
  db.upsertCalendarEventFromNostr(
    makeTimedEvent({ id: "1".repeat(64), pubkey: otherPubkey, tags: [["d", "other"]] }),
    "wss://relay.example"
  );

  const mine = db.listCalendarEventsFiltered({ pubkeys: [PUBKEY] });
  assert.equal(mine.length, 1);
  assert.equal(mine[0].pubkey, PUBKEY);

  db.close();
});

test("listCalendarEventsFiltered filters by tag", () => {
  const db = openDb(mkDbPath());

  db.upsertCalendarEventFromNostr(makeTimedEvent(), "wss://relay.example");
  db.upsertCalendarEventFromNostr(
    makeDateEvent({ id: "2".repeat(64) }),
    "wss://relay.example"
  );

  const workEvents = db.listCalendarEventsFiltered({ tags: ["work"] });
  assert.equal(workEvents.length, 1);
  assert.equal(workEvents[0].d_tag, "planning-2026");

  db.close();
});

// ── ICS: calendarEventToVevent ────────────────────────────────────────────────

test("calendarEventToVevent produces valid VEVENT for timed event", () => {
  const db = openDb(mkDbPath());
  db.upsertCalendarEventFromNostr(makeTimedEvent(), "wss://relay.example");
  const stored = db.getCalendarEventByUid(`${"e".repeat(64)}@nostr-calendar`);

  const ics = calendarEventToVevent(stored);

  assert.match(ics, /BEGIN:VEVENT/);
  assert.match(ics, /END:VEVENT/);
  assert.match(ics, /SUMMARY:Q1 Planning/);
  assert.match(ics, /DESCRIPTION:Annual planning session/);
  assert.match(ics, /DTSTART:/);
  assert.match(ics, /DTEND:/);
  assert.match(ics, /LOCATION:Conference Room A/);
  assert.match(ics, /URL:nostr:nevent1/);
  assert.match(ics, /CATEGORIES:/);
  assert.doesNotMatch(ics, /DTSTART;VALUE=DATE/);

  db.close();
});

test("calendarEventToVevent produces DATE-type DTSTART for all-day event", () => {
  const db = openDb(mkDbPath());
  db.upsertCalendarEventFromNostr(makeDateEvent(), "wss://relay.example");
  const stored = db.getCalendarEventByUid(`${"f".repeat(64)}@nostr-calendar`);

  const ics = calendarEventToVevent(stored);

  assert.match(ics, /BEGIN:VEVENT/);
  assert.match(ics, /DTSTART;VALUE=DATE:20260704/);
  assert.match(ics, /DTEND;VALUE=DATE:20260705/);
  assert.doesNotMatch(ics, /DTSTART:/, "should not have datetime DTSTART for all-day event");

  db.close();
});

// ── caldav-calendars: helpers ─────────────────────────────────────────────────

test("listCalendarEventsForCalendar returns events matching calendar filter", () => {
  const db = openDb(mkDbPath());
  db.upsertCalendarEventFromNostr(makeTimedEvent(), "wss://relay.example");

  const events = listCalendarEventsForCalendar(db, { filter: { pubkeys: [PUBKEY] } });
  assert.equal(events.length, 1);

  db.close();
});

test("listCalendarEventsForCalendar returns empty for unknown pubkey", () => {
  const db = openDb(mkDbPath());
  db.upsertCalendarEventFromNostr(makeTimedEvent(), "wss://relay.example");

  const events = listCalendarEventsForCalendar(db, { filter: { pubkeys: ["c".repeat(64)] } });
  assert.equal(events.length, 0);

  db.close();
});

test("calendarEventVisibleToPrincipal always returns true", () => {
  const calEvent = { pubkey: PUBKEY };
  const principal = { pubkeys: [PUBKEY], username: "alice" };
  assert.equal(calendarEventVisibleToPrincipal(calEvent, principal), true);
});

// ── caldav-core: runReportQuery with calendar events ─────────────────────────

test("runReportQuery sync-collection includes calendar events", () => {
  const db = openDb(mkDbPath());
  db.upsertCalendarEventFromNostr(makeTimedEvent(), "wss://relay.example");
  const stored = db.getCalendarEventByUid(`${"e".repeat(64)}@nostr-calendar`);

  const result = runReportQuery({
    issues: [],
    calendarEvents: [stored],
    reportBody: `<?xml version="1.0"?>
      <d:sync-collection xmlns:d="DAV:">
        <d:sync-token>urn:sync-token:0</d:sync-token>
        <d:sync-level>1</d:sync-level>
        <d:prop><d:getetag/></d:prop>
      </d:sync-collection>`,
    syncToken: 5
  });

  assert.equal(result.type, "sync-collection");
  assert.equal(result.calendarEvents.length, 1);
  assert.equal(result.calendarEvents[0].caldav_uid, stored.caldav_uid);

  db.close();
});

test("runReportQuery calendar-query VEVENT filter returns only calendar events", () => {
  const db = openDb(mkDbPath());
  db.upsertCalendarEventFromNostr(makeTimedEvent(), "wss://relay.example");
  const stored = db.getCalendarEventByUid(`${"e".repeat(64)}@nostr-calendar`);

  db.upsertIssueFromNostr(
    {
      id: "1".repeat(64),
      pubkey: PUBKEY,
      kind: 1621,
      created_at: 1710000000,
      content: "issue body",
      tags: [["subject", "Some Issue"]]
    },
    "wss://relay.example"
  );
  const issue = db.getIssueByEventId("1".repeat(64));

  const result = runReportQuery({
    issues: [issue],
    calendarEvents: [stored],
    reportBody: `<?xml version="1.0"?>
      <c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
        <d:prop><c:calendar-data/></d:prop>
        <c:filter>
          <c:comp-filter name="VCALENDAR">
            <c:comp-filter name="VEVENT"/>
          </c:comp-filter>
        </c:filter>
      </c:calendar-query>`,
    syncToken: 1
  });

  assert.equal(result.type, "calendar-query");
  assert.equal(result.results.length, 1);
  assert.ok(result.results[0].calendarEvent, "result should be a calendar event");
  assert.equal(result.results[0].calendarEvent.caldav_uid, stored.caldav_uid);

  db.close();
});

test("runReportQuery calendar-query VTODO filter returns only issues", () => {
  const db = openDb(mkDbPath());
  db.upsertCalendarEventFromNostr(makeTimedEvent(), "wss://relay.example");
  const stored = db.getCalendarEventByUid(`${"e".repeat(64)}@nostr-calendar`);

  db.upsertIssueFromNostr(
    {
      id: "1".repeat(64),
      pubkey: PUBKEY,
      kind: 1621,
      created_at: 1710000000,
      content: "issue body",
      tags: [["subject", "Some Issue"]]
    },
    "wss://relay.example"
  );
  const issue = db.getIssueByEventId("1".repeat(64));

  const result = runReportQuery({
    issues: [issue],
    calendarEvents: [stored],
    reportBody: `<?xml version="1.0"?>
      <c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
        <d:prop><c:calendar-data/></d:prop>
        <c:filter>
          <c:comp-filter name="VCALENDAR">
            <c:comp-filter name="VTODO"/>
          </c:comp-filter>
        </c:filter>
      </c:calendar-query>`,
    syncToken: 1
  });

  assert.equal(result.type, "calendar-query");
  assert.equal(result.results.length, 1);
  assert.ok(result.results[0].issue, "result should be an issue");

  db.close();
});

test("runReportQuery sync-collection excludes cal events when token is current", () => {
  const db = openDb(mkDbPath());
  db.upsertCalendarEventFromNostr(makeTimedEvent(), "wss://relay.example");
  const stored = db.getCalendarEventByUid(`${"e".repeat(64)}@nostr-calendar`);
  const syncToken = db.getSyncToken();

  const result = runReportQuery({
    issues: [],
    calendarEvents: [stored],
    reportBody: `<?xml version="1.0"?>
      <d:sync-collection xmlns:d="DAV:">
        <d:sync-token>urn:sync-token:${syncToken}</d:sync-token>
        <d:sync-level>1</d:sync-level>
        <d:prop><d:getetag/></d:prop>
      </d:sync-collection>`,
    syncToken
  });

  assert.equal(result.calendarEvents.length, 0, "no updates when client token matches server token");

  db.close();
});
