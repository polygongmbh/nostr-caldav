import test from "node:test";
import assert from "node:assert/strict";
import { buildPrincipalCalendars, issueVisibleInCalendar } from "../src/caldav-calendars.js";

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
