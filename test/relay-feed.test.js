import test from "node:test";
import assert from "node:assert/strict";
import { nostrCalendarEventsToIcsFeed } from "../src/ics.js";
import { createCaldavServer } from "../src/caldav.js";

const FAKE_PUBKEY = "a".repeat(64);
const FAKE_ID = "b".repeat(64);

// Minimal DB stub — avoids the better-sqlite3 native addon entirely.
// The relay-feed route never touches the DB; the CalDAV routes only reach
// it after auth, which is all we need to verify for the 401 test.
const mockDb = {
  listIssuesFiltered: () => [],
  listIssues: () => [],
  listDistinctCalendarEventTagCombinations: () => [],
  getSyncToken: () => 0,
  getIssueByEventId: () => null,
  getIssueByUid: () => null,
  getCalendarEventByUid: () => null,
  issueHasSubtasks: () => false,
  logSync: () => {},
  close: () => {}
};

const caldavConfig = {
  baseUrl: "http://127.0.0.1",
  username: "user",
  password: "password",
  principals: [{ username: "user", password: "password", pubkeys: [], calendars: [] }]
};

const stubSyncService = { async publishStatusFromCaldav() { return { skipped: true }; } };

test("nostrCalendarEventsToIcsFeed produces valid VCALENDAR with VEVENT", () => {
  const events = [
    {
      id: FAKE_ID,
      pubkey: FAKE_PUBKEY,
      kind: 31923,
      created_at: 1710000000,
      content: "Team call",
      tags: [
        ["d", "meeting-001"],
        ["title", "Weekly sync"],
        ["start", "1710000000"],
        ["end", "1710003600"],
        ["t", "team"]
      ]
    }
  ];

  const ics = nostrCalendarEventsToIcsFeed(events, { calendarName: "Test Relay" });
  assert.ok(ics.includes("BEGIN:VCALENDAR"), "has VCALENDAR");
  assert.ok(ics.includes("BEGIN:VEVENT"), "has VEVENT");
  assert.ok(ics.includes("END:VEVENT"), "has END:VEVENT");
  assert.ok(ics.includes("END:VCALENDAR"), "has END:VCALENDAR");
  assert.ok(ics.includes("SUMMARY:Weekly sync"), "has summary");
  assert.ok(ics.includes("X-WR-CALNAME:Test Relay"), "has calendar name");
  assert.ok(ics.includes("CATEGORIES:team"), "has categories");
  assert.ok(ics.includes("DESCRIPTION:Team call"), "has description");
});

test("nostrCalendarEventsToIcsFeed skips events without a start tag", () => {
  const events = [
    {
      id: FAKE_ID,
      pubkey: FAKE_PUBKEY,
      kind: 31923,
      created_at: 1710000000,
      content: "",
      tags: [["d", "no-start"], ["title", "No start date"]]
    }
  ];
  const ics = nostrCalendarEventsToIcsFeed(events);
  assert.ok(!ics.includes("BEGIN:VEVENT"), "no VEVENT for event without start");
});

test("nostrCalendarEventsToIcsFeed handles all-day events (kind 31922)", () => {
  const events = [
    {
      id: FAKE_ID,
      pubkey: FAKE_PUBKEY,
      kind: 31922,
      created_at: 1710000000,
      content: "",
      tags: [
        ["d", "holiday-001"],
        ["title", "Company holiday"],
        ["start", "2024-03-20"],
        ["end", "2024-03-21"]
      ]
    }
  ];
  const ics = nostrCalendarEventsToIcsFeed(events);
  assert.ok(ics.includes("DTSTART;VALUE=DATE:20240320"), "all-day DTSTART");
  assert.ok(ics.includes("DTEND;VALUE=DATE:20240321"), "all-day DTEND");
});

test("nostrCalendarEventsToIcsFeed with empty array returns valid empty calendar", () => {
  const ics = nostrCalendarEventsToIcsFeed([]);
  assert.ok(ics.includes("BEGIN:VCALENDAR"), "has VCALENDAR");
  assert.ok(ics.includes("END:VCALENDAR"), "has END:VCALENDAR");
  assert.ok(!ics.includes("BEGIN:VEVENT"), "no VEVENTs");
});

test("nostrCalendarEventsToIcsFeed multiple events all appear", () => {
  const events = [
    {
      id: "1".repeat(64), pubkey: FAKE_PUBKEY, kind: 31923, created_at: 1710000000,
      content: "", tags: [["d", "ev1"], ["title", "First"], ["start", "1710000000"]]
    },
    {
      id: "2".repeat(64), pubkey: FAKE_PUBKEY, kind: 31923, created_at: 1710000001,
      content: "", tags: [["d", "ev2"], ["title", "Second"], ["start", "1710003600"]]
    }
  ];
  const ics = nostrCalendarEventsToIcsFeed(events);
  assert.equal((ics.match(/BEGIN:VEVENT/g) || []).length, 2, "two VEVENTs");
  assert.ok(ics.includes("SUMMARY:First"), "first event");
  assert.ok(ics.includes("SUMMARY:Second"), "second event");
});

test("/relay/:hostname returns ICS feed without authentication", async () => {
  const mockEvents = [
    {
      id: FAKE_ID,
      pubkey: FAKE_PUBKEY,
      kind: 31923,
      created_at: 1710000000,
      content: "desc",
      tags: [["d", "ev-1"], ["title", "Test event"], ["start", "1710000000"]]
    }
  ];

  const app = createCaldavServer({
    db: mockDb,
    caldavConfig,
    syncService: stubSyncService,
    trackedPubkeys: [],
    relayFeedFetcher: async (relayUrl) => {
      assert.equal(relayUrl, "wss://test.relay.example");
      return mockEvents;
    }
  });

  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const { port } = server.address();

  // No Authorization header — must succeed
  const res = await fetch(`http://127.0.0.1:${port}/relay/test.relay.example`);
  assert.equal(res.status, 200);
  assert.ok(res.headers.get("content-type").includes("text/calendar"), "content-type is text/calendar");
  const body = await res.text();
  assert.ok(body.includes("BEGIN:VCALENDAR"), "VCALENDAR in response");
  assert.ok(body.includes("SUMMARY:Test event"), "event in response");
  assert.ok(body.includes("X-WR-CALNAME:test.relay.example"), "calendar named after relay");

  await new Promise((resolve) => server.close(resolve));
});

test("/relay/:hostname.ics strips .ics suffix and works identically", async () => {
  let receivedUrl = null;

  const app = createCaldavServer({
    db: mockDb, caldavConfig, syncService: stubSyncService, trackedPubkeys: [],
    relayFeedFetcher: async (relayUrl) => { receivedUrl = relayUrl; return []; }
  });

  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const { port } = server.address();

  const res = await fetch(`http://127.0.0.1:${port}/relay/my.relay.example.ics`);
  assert.equal(res.status, 200);
  assert.equal(receivedUrl, "wss://my.relay.example", ".ics stripped before relay URL");
  const body = await res.text();
  assert.ok(body.includes("BEGIN:VCALENDAR"), "returns valid ICS");

  await new Promise((resolve) => server.close(resolve));
});

test("/relay/:hostname prepends wss:// and passes relay URL to fetcher", async () => {
  let receivedUrl = null;

  const app = createCaldavServer({
    db: mockDb, caldavConfig, syncService: stubSyncService, trackedPubkeys: [],
    relayFeedFetcher: async (relayUrl) => { receivedUrl = relayUrl; return []; }
  });

  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const { port } = server.address();

  await fetch(`http://127.0.0.1:${port}/relay/my.relay.example`);
  assert.equal(receivedUrl, "wss://my.relay.example", "wss:// prepended");

  await new Promise((resolve) => server.close(resolve));
});

test("/relay/:hostname returns 502 when fetcher throws", async () => {
  const app = createCaldavServer({
    db: mockDb, caldavConfig, syncService: stubSyncService, trackedPubkeys: [],
    relayFeedFetcher: async () => { throw new Error("connection refused"); }
  });

  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const { port } = server.address();

  const res = await fetch(`http://127.0.0.1:${port}/relay/bad.relay.example`);
  assert.equal(res.status, 502);

  await new Promise((resolve) => server.close(resolve));
});

test("/relay/:hostname returns 503 when no fetcher configured", async () => {
  const app = createCaldavServer({
    db: mockDb, caldavConfig, syncService: stubSyncService, trackedPubkeys: []
    // relayFeedFetcher intentionally omitted
  });

  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const { port } = server.address();

  const res = await fetch(`http://127.0.0.1:${port}/relay/some.relay.example`);
  assert.equal(res.status, 503);

  await new Promise((resolve) => server.close(resolve));
});

test("existing CalDAV routes still require authentication after relay route added", async () => {
  const app = createCaldavServer({
    db: mockDb, caldavConfig, syncService: stubSyncService, trackedPubkeys: [],
    relayFeedFetcher: async () => []
  });

  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const { port } = server.address();

  const res = await fetch(`http://127.0.0.1:${port}/calendars/user/`);
  assert.equal(res.status, 401, "CalDAV still requires auth");

  await new Promise((resolve) => server.close(resolve));
});
