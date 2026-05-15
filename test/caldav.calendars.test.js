import test from "node:test";
import assert from "node:assert/strict";
import { buildPrincipalCalendars, issueVisibleInCalendar, issueVisibleToPrincipal } from "../src/caldav-calendars.js";

test("buildPrincipalCalendars creates base and pubkey calendars", () => {
  const principal = {
    username: "u",
    password: "p",
    pubkeys: [],
    calendars: [{ id: "bugs", name: "Bugs", labels: ["bug"] }]
  };

  const calendars = buildPrincipalCalendars(principal, ["a".repeat(64), "b".repeat(64)]);
  const ids = calendars.map((c) => c.id);

  assert.ok(ids.includes("nostr-issues"));
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
