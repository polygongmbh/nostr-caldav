import test from "node:test";
import assert from "node:assert/strict";
import {
  buildPrincipalCalendars,
  buildCalendarEventCals,
  issueVisibleInCalendar,
  issueVisibleToPrincipal,
  calendarEventVisibleToPrincipal,
  applyListVisibilityRules,
  listIssuesForCalendar,
  SMALL_LIST_THRESHOLD
} from "../src/caldav-calendars.js";

test("buildPrincipalCalendars creates base and pubkey calendars", () => {
  const principal = {
    username: "u",
    password: "p",
    pubkeys: [],
    calendars: [{ id: "bugs", name: "Bugs", labels: ["bug"] }]
  };

  const calendars = buildPrincipalCalendars(principal, ["a".repeat(64), "b".repeat(64)]);
  const ids = calendars.map((c) => c.id);

  assert.ok(ids.includes(`pubkey-${"a".repeat(12)}`));
  assert.ok(ids.includes("bugs"));
});

test("buildPrincipalCalendars creates one calendar per channel tag", () => {
  const principal = {
    username: "me@example.com",
    password: "p",
    pubkeys: ["a".repeat(64)],
    calendars: []
  };

  const calendars = buildPrincipalCalendars(principal, [], { channelTags: ["ops", "frontend"] });
  const ids = calendars.map((c) => c.id);
  assert.ok(ids.includes("channel-ops"));
  assert.ok(ids.includes("channel-frontend"));
});

test("issueVisibleInCalendar applies labels and status filters", () => {
  const issue = {
    pubkey: "a".repeat(64),
    status: "open",
    labels: JSON.stringify(["bug", "p1"]),
    subject: "subject",
    body: "body"
  };

  assert.equal(
    issueVisibleInCalendar(issue, {
      filter: { labels: ["bug"], statuses: ["open"], pubkeys: ["a".repeat(64)] }
    }),
    true
  );

  assert.equal(
    issueVisibleInCalendar(issue, {
      filter: { labels: ["chore"] }
    }),
    false
  );
});

test("issueVisibleToPrincipal allows mention to me and my own unmentioned tasks only", () => {
  const principal = {
    username: "me@example.com",
    pubkeys: ["a".repeat(64)]
  };

  const mentioned = {
    pubkey: "b".repeat(64),
    mention_pubkeys: JSON.stringify(["a".repeat(64)]),
    mention_handles: JSON.stringify([])
  };
  assert.equal(issueVisibleToPrincipal(mentioned, principal), true);

  const mineNoMentions = {
    pubkey: "a".repeat(64),
    mention_pubkeys: JSON.stringify([]),
    mention_handles: JSON.stringify([])
  };
  assert.equal(issueVisibleToPrincipal(mineNoMentions, principal), true);

  const mineMentionsOther = {
    pubkey: "a".repeat(64),
    mention_pubkeys: JSON.stringify(["c".repeat(64)]),
    mention_handles: JSON.stringify([])
  };
  assert.equal(issueVisibleToPrincipal(mineMentionsOther, principal), false);
});

test("applyListVisibilityRules shows lists with more than SMALL_LIST_THRESHOLD issues normally", () => {
  const bigIssues = Array.from({ length: SMALL_LIST_THRESHOLD + 1 }, (_, i) => ({
    event_id: `evt-big-${i}`,
    pubkey: "a".repeat(64),
    mention_pubkeys: JSON.stringify([]),
    mention_handles: JSON.stringify([]),
    status: i === 0 ? "open" : "completed"  // at least one open, rest closed — total counts toward threshold
  }));
  const smallIssues = [
    {
      event_id: "evt-small-0",
      pubkey: "a".repeat(64),
      mention_pubkeys: JSON.stringify([]),
      mention_handles: JSON.stringify([]),
      status: "open"
    }
  ];

  const bigCal = { id: "big-list", name: "Big List", filter: { pubkeys: ["big"] } };
  const smallCal = { id: "small-list", name: "Small List", filter: { pubkeys: ["small"] } };

  const db = {
    listIssuesFiltered(filter) {
      if (filter?.pubkeys?.includes("big")) return bigIssues;
      if (filter?.pubkeys?.includes("small")) return smallIssues;
      return [];
    },
    listCalendarEventsFiltered() { return []; },
    getIssueByEventId() { return null; }
  };

  const principal = { username: "me", pubkeys: ["a".repeat(64)] };
  const result = applyListVisibilityRules(db, principal, [bigCal, smallCal]);

  const ids = result.map((c) => c.id);
  assert.ok(ids.includes("big-list"), "big list should be visible");
  assert.ok(!ids.includes("small-list"), "small list should not be shown independently");
  assert.ok(ids.includes("other-tasks"), "other-tasks should appear");
  assert.equal(ids[ids.length - 1], "other-tasks", "other-tasks must be last");
});

test("applyListVisibilityRules collects small-list issues into other-tasks", () => {
  const smallIssue = {
    event_id: "evt-small-0",
    pubkey: "a".repeat(64),
    mention_pubkeys: JSON.stringify([]),
    mention_handles: JSON.stringify([]),
    status: "open"
  };
  const smallCal = { id: "small-list", name: "Small List", filter: { pubkeys: ["small"] } };

  const db = {
    listIssuesFiltered(filter) {
      if (filter?.pubkeys?.includes("small")) return [smallIssue];
      return [];
    },
    listCalendarEventsFiltered() { return []; },
    getIssueByEventId() { return null; }
  };

  const principal = { username: "me", pubkeys: ["a".repeat(64)] };
  const result = applyListVisibilityRules(db, principal, [smallCal]);
  const otherTasks = result.find((c) => c.id === "other-tasks");

  assert.ok(otherTasks, "other-tasks calendar should be created");
  assert.equal(otherTasks.isOtherTasks, true);
  assert.equal(otherTasks.collectedCalendars.length, 1);
  assert.equal(otherTasks.collectedCalendars[0].id, "small-list");
});

test("applyListVisibilityRules drops calendars with zero visible issues", () => {
  const emptyCal = { id: "empty-list", name: "Empty", filter: { pubkeys: ["nobody"] } };

  const db = {
    listIssuesFiltered() { return []; },
    listCalendarEventsFiltered() { return []; },
    getIssueByEventId() { return null; }
  };

  const principal = { username: "me", pubkeys: ["a".repeat(64)] };
  const result = applyListVisibilityRules(db, principal, [emptyCal]);

  assert.equal(result.length, 0, "empty calendars should be dropped");
});

test("applyListVisibilityRules drops calendars with only closed issues", () => {
  const closedIssues = Array.from({ length: 3 }, (_, i) => ({
    event_id: `evt-closed-${i}`,
    pubkey: "a".repeat(64),
    mention_pubkeys: JSON.stringify([]),
    mention_handles: JSON.stringify([]),
    status: "completed"
  }));
  const cal = { id: "closed-only", name: "Closed Only", filter: {} };

  const db = {
    listIssuesFiltered() { return closedIssues; },
    listCalendarEventsFiltered() { return []; },
    getIssueByEventId() { return null; }
  };

  const principal = { username: "me", pubkeys: ["a".repeat(64)] };
  const result = applyListVisibilityRules(db, principal, [cal]);

  assert.equal(result.length, 0, "closed-only calendars should be hidden");
});

test("applyListVisibilityRules returns no other-tasks when all lists are large", () => {
  const bigIssues = Array.from({ length: SMALL_LIST_THRESHOLD + 2 }, (_, i) => ({
    event_id: `evt-${i}`,
    pubkey: "a".repeat(64),
    mention_pubkeys: JSON.stringify([]),
    mention_handles: JSON.stringify([]),
    status: "open"
  }));
  const cal = { id: "big", name: "Big", filter: {} };

  const db = {
    listIssuesFiltered() { return bigIssues; },
    listCalendarEventsFiltered() { return []; },
    getIssueByEventId() { return null; }
  };

  const principal = { username: "me", pubkeys: ["a".repeat(64)] };
  const result = applyListVisibilityRules(db, principal, [cal]);

  assert.equal(result.length, 1);
  assert.equal(result[0].id, "big");
  assert.ok(!result.find((c) => c.id === "other-tasks"));
});

test("applyListVisibilityRules drops calendars with calendar events but no open issues", () => {
  const cal = { id: "cal-with-events", name: "Has Events", filter: {} };

  const db = {
    listIssuesFiltered() { return []; },
    listCalendarEventsFiltered() { return [{ event_id: "ev1", caldav_uid: "u1" }]; },
    getIssueByEventId() { return null; },
    issueHasSubtasks() { return false; }
  };

  const principal = { username: "me", pubkeys: ["a".repeat(64)] };
  const result = applyListVisibilityRules(db, principal, [cal]);

  assert.equal(result.length, 0, "no open issues means calendar is dropped regardless of cal events");
});

test("listIssuesForCalendar combines issues from collectedCalendars for other-tasks", () => {
  const issue1 = { event_id: "e1", pubkey: "a".repeat(64) };
  const issue2 = { event_id: "e2", pubkey: "b".repeat(64) };
  const issue3 = { event_id: "e1", pubkey: "a".repeat(64) }; // duplicate of issue1

  const db = {
    listIssuesFiltered(filter) {
      if (filter?.pubkeys?.includes("a")) return [issue1, issue3];
      if (filter?.pubkeys?.includes("b")) return [issue2];
      return [];
    }
  };

  const otherTasks = {
    id: "other-tasks",
    name: "Other Tasks",
    isOtherTasks: true,
    collectedCalendars: [
      { id: "a-list", filter: { pubkeys: ["a"] } },
      { id: "b-list", filter: { pubkeys: ["b"] } }
    ],
    filter: {}
  };

  const result = listIssuesForCalendar(db, otherTasks);
  assert.equal(result.length, 2, "duplicates should be de-duplicated");
  assert.ok(result.find((i) => i.event_id === "e1"));
  assert.ok(result.find((i) => i.event_id === "e2"));
});

test("issueVisibleToPrincipal: relayFilter matches via relay_urls JSON array", () => {
  const principal = {
    username: "me@example.com",
    pubkeys: ["a".repeat(64)],
    relayFilter: "wss://relay.target.com"
  };
  const base = { pubkey: "a".repeat(64), mention_pubkeys: JSON.stringify([]), mention_handles: JSON.stringify([]) };

  // relay_urls array contains the target relay
  assert.equal(
    issueVisibleToPrincipal({ ...base, relay_url: null, relay_urls: JSON.stringify(["wss://relay.other.com", "wss://relay.target.com"]) }, principal),
    true, "should match when target relay is in relay_urls array"
  );

  // relay_urls array does not contain the target relay
  assert.equal(
    issueVisibleToPrincipal({ ...base, relay_url: null, relay_urls: JSON.stringify(["wss://relay.other.com"]) }, principal),
    false, "should not match when target relay is absent from relay_urls"
  );

  // relay_urls null/empty, fallback to relay_url
  assert.equal(
    issueVisibleToPrincipal({ ...base, relay_url: "wss://relay.target.com", relay_urls: null }, principal),
    true, "fallback to relay_url when relay_urls is null"
  );
  assert.equal(
    issueVisibleToPrincipal({ ...base, relay_url: "wss://relay.other.com", relay_urls: null }, principal),
    false, "fallback relay_url mismatch hides issue"
  );

  // no relay anywhere → hidden
  assert.equal(
    issueVisibleToPrincipal({ ...base, relay_url: null, relay_urls: null }, principal),
    false, "issue with no relay info should be hidden"
  );

  // relay_url = "multi-relay" with no relay_urls → hidden for issues (no bypass)
  assert.equal(
    issueVisibleToPrincipal({ ...base, relay_url: "multi-relay", relay_urls: null }, principal),
    false, "multi-relay placeholder without relay_urls data should hide issue from relay-filtered principal"
  );
});

test("issueVisibleToPrincipal: relay URL trailing slash is normalized for comparison", () => {
  const principal = {
    username: "me@example.com",
    pubkeys: ["a".repeat(64)],
    relayFilter: "wss://relay.target.com"
  };
  const base = { pubkey: "a".repeat(64), mention_pubkeys: JSON.stringify([]), mention_handles: JSON.stringify([]) };

  assert.equal(
    issueVisibleToPrincipal({ ...base, relay_url: "wss://relay.target.com/", relay_urls: null }, principal),
    true, "trailing slash in relay_url should be normalized"
  );
  assert.equal(
    issueVisibleToPrincipal({ ...base, relay_url: null, relay_urls: JSON.stringify(["wss://relay.target.com/"]) }, principal),
    true, "trailing slash in relay_urls entry should be normalized"
  );
});

test("issueVisibleToPrincipal: no relayFilter means all relays pass", () => {
  const principal = { username: "me@example.com", pubkeys: ["a".repeat(64)], relayFilter: null };
  const issue = {
    pubkey: "a".repeat(64),
    relay_url: "wss://any.relay.com",
    relay_urls: JSON.stringify(["wss://any.relay.com"]),
    mention_pubkeys: JSON.stringify([]),
    mention_handles: JSON.stringify([])
  };
  assert.equal(issueVisibleToPrincipal(issue, principal), true, "no relay filter passes all relays");
});

test("calendarEventVisibleToPrincipal: relayFilter uses relay_urls array and falls back to relay_url", () => {
  const principal = {
    username: "me@example.com",
    pubkeys: ["a".repeat(64)],
    relayFilter: "wss://relay.target.com"
  };

  // Found in relay_urls array
  assert.equal(
    calendarEventVisibleToPrincipal({ relay_url: null, relay_urls: JSON.stringify(["wss://relay.other.com", "wss://relay.target.com"]) }, principal),
    true, "should match when target is in relay_urls"
  );
  // Not in relay_urls
  assert.equal(
    calendarEventVisibleToPrincipal({ relay_url: null, relay_urls: JSON.stringify(["wss://relay.other.com"]) }, principal),
    false, "should not match when target absent from relay_urls"
  );
  // relay_urls null, fallback to relay_url
  assert.equal(
    calendarEventVisibleToPrincipal({ relay_url: "wss://relay.target.com", relay_urls: null }, principal),
    true, "fallback to relay_url matches"
  );
  assert.equal(
    calendarEventVisibleToPrincipal({ relay_url: "wss://relay.target.com/", relay_urls: null }, principal),
    true, "trailing slash in relay_url normalized"
  );
  assert.equal(
    calendarEventVisibleToPrincipal({ relay_url: null, relay_urls: null }, principal),
    false, "no relay info hides event"
  );
  // relay_url = "multi-relay" with no relay_urls → hidden (no relay attribution, strict filter)
  assert.equal(
    calendarEventVisibleToPrincipal({ relay_url: "multi-relay", relay_urls: null }, principal),
    false, "legacy multi-relay placeholder has no per-relay attribution and is hidden from relay-filtered accounts"
  );
});

test("calendarEventVisibleToPrincipal: no relayFilter passes all events", () => {
  const principal = { username: "me@example.com", pubkeys: [], relayFilter: null };
  assert.equal(calendarEventVisibleToPrincipal({ relay_url: "wss://any.relay", relay_urls: null }, principal), true);
  assert.equal(calendarEventVisibleToPrincipal({ relay_url: null, relay_urls: null }, principal), true);
});

test("issueVisibleToPrincipal allows children of visible parent tasks", () => {
  const principal = {
    username: "me@example.com",
    pubkeys: ["a".repeat(64)]
  };
  const parent = {
    event_id: "p".repeat(64),
    pubkey: "b".repeat(64),
    mention_pubkeys: JSON.stringify(["a".repeat(64)]),
    mention_handles: JSON.stringify([])
  };
  const child = {
    pubkey: "c".repeat(64),
    parent_event_id: parent.event_id,
    mention_pubkeys: JSON.stringify([]),
    mention_handles: JSON.stringify([])
  };

  assert.equal(
    issueVisibleToPrincipal(child, principal, {
      getIssueByEventId(eventId) {
        return eventId === parent.event_id ? parent : null;
      }
    }),
    true
  );
});

test("buildCalendarEventCals creates one calendar per tag combination", () => {
  const cals = buildCalendarEventCals([["nodex", "dev"], ["nodex"], ["nostr", "dev"]]);
  const ids = cals.map((c) => c.id);
  assert.ok(ids.includes("calev-dev-nodex"), "#nodex #dev calendar");
  assert.ok(ids.includes("calev-nodex"), "#nodex calendar");
  assert.ok(ids.includes("calev-dev-nostr"), "#nostr #dev calendar");
  assert.equal(ids.length, 3);
});

test("buildCalendarEventCals creates calev-other for empty tag combo", () => {
  const cals = buildCalendarEventCals([[]]);
  assert.equal(cals.length, 1);
  assert.equal(cals[0].id, "calev-other");
  assert.equal(cals[0].name, "Other Events");
  assert.equal(cals[0].isCalendarEventCalendar, true);
});

test("buildCalendarEventCals combo calendars have exactTags filter and isCalendarEventCalendar", () => {
  const cals = buildCalendarEventCals([["dev", "nodex"]]);
  assert.equal(cals.length, 1);
  assert.deepEqual(cals[0].filter.exactTags, ["dev", "nodex"]);
  assert.equal(cals[0].isCalendarEventCalendar, true);
});

test("applyListVisibilityRules is unaffected by isCalendarEventCalendar flag — drops cals with no issues", () => {
  const comboCal = {
    id: "calev-dev",
    name: "#dev",
    filter: { exactTags: ["dev"] },
    isCalendarEventCalendar: true
  };

  const db = {
    listIssuesFiltered() { return []; },
    listCalendarEventsFiltered() { return []; },
    getIssueByEventId() { return null; },
    issueHasSubtasks() { return false; }
  };

  const principal = { username: "me", pubkeys: ["a".repeat(64)] };
  const result = applyListVisibilityRules(db, principal, [comboCal]);

  // applyListVisibilityRules only cares about issues; it will drop this calendar since it has none.
  // Calev calendars are combined AFTER applyListVisibilityRules in caldav.js, not inside it.
  assert.equal(result.length, 0, "applyListVisibilityRules drops anything with no open issues");
});
