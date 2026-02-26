import test from "node:test";
import assert from "node:assert/strict";
import { issueToVtodo, parseVtodo } from "../src/ics.js";

test("parseVtodo extracts key fields", () => {
  const ics = [
    "BEGIN:VCALENDAR",
    "BEGIN:VTODO",
    "UID:abc@nostr",
    "SUMMARY:Ship it",
    "DESCRIPTION:line1",
    "STATUS:COMPLETED",
    "SEQUENCE:9",
    "END:VTODO",
    "END:VCALENDAR"
  ].join("\r\n");

  const parsed = parseVtodo(ics);
  assert.equal(parsed.uid, "abc@nostr");
  assert.equal(parsed.status, "COMPLETED");
  assert.equal(parsed.internalStatus, "completed");
  assert.equal(parsed.sequence, 9);
});

test("parseVtodo infers completed when COMPLETED exists", () => {
  const ics = [
    "BEGIN:VCALENDAR",
    "BEGIN:VTODO",
    "UID:abc@nostr",
    "SUMMARY:Ship it",
    "COMPLETED:20260226T120000Z",
    "END:VTODO",
    "END:VCALENDAR"
  ].join("\r\n");

  const parsed = parseVtodo(ics);
  assert.equal(parsed.internalStatus, "completed");
});

test("issueToVtodo encodes labels, url, and open status", () => {
  const raw = issueToVtodo({
    event_id: "f".repeat(64),
    pubkey: "a".repeat(64),
    subject: "Task",
    body: "Body",
    labels: JSON.stringify(["bug", "p1"]),
    created_at: 1710000000,
    last_modified: 1710000001,
    sequence: 2,
    status: "open",
    caldav_uid: "uid-1"
  });

  assert.match(raw, /BEGIN:VTODO/);
  assert.match(raw, /STATUS:NEEDS-ACTION/);
  assert.match(raw, /CATEGORIES:bug,p1/);
  assert.match(raw, /URL:nostr:nevent1/);
});
