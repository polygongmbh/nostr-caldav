import test from "node:test";
import assert from "node:assert/strict";
import { issueToVtodo, parseVtodo, parseVevent } from "../src/ics.js";

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

test("parseVevent extracts all-day event", () => {
  const ics = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "BEGIN:VEVENT",
    "UID:allday@apple",
    "SUMMARY:All Day Event",
    "DESCRIPTION:A full day",
    "DTSTART;VALUE=DATE:20260620",
    "DTEND;VALUE=DATE:20260621",
    "END:VEVENT",
    "END:VCALENDAR"
  ].join("\r\n");

  const parsed = parseVevent(ics);
  assert.equal(parsed.uid, "allday@apple");
  assert.equal(parsed.summary, "All Day Event");
  assert.equal(parsed.description, "A full day");
  assert.equal(parsed.isAllDay, true);
  assert.equal(parsed.startDate, "2026-06-20");
  assert.equal(parsed.endDate, "2026-06-21");
  assert.equal(parsed.startAt, null);
  assert.equal(parsed.endAt, null);
});

test("parseVevent extracts UTC timed event", () => {
  const ics = [
    "BEGIN:VCALENDAR",
    "BEGIN:VEVENT",
    "UID:timed@apple",
    "SUMMARY:Morning Standup",
    "DTSTART:20260617T090000Z",
    "DTEND:20260617T093000Z",
    "LOCATION:Office",
    "CATEGORIES:work,standup",
    "END:VEVENT",
    "END:VCALENDAR"
  ].join("\r\n");

  const parsed = parseVevent(ics);
  assert.equal(parsed.uid, "timed@apple");
  assert.equal(parsed.summary, "Morning Standup");
  assert.equal(parsed.isAllDay, false);
  assert.equal(parsed.startAt, 1781686800); // 2026-06-17T09:00:00Z
  assert.equal(parsed.endAt, 1781688600);   // 2026-06-17T09:30:00Z
  assert.equal(parsed.location, "Office");
  assert.deepEqual(parsed.labels, ["work", "standup"]);
});

test("parseVevent handles TZID datetime", () => {
  const ics = [
    "BEGIN:VCALENDAR",
    "BEGIN:VEVENT",
    "UID:tzid@apple",
    "SUMMARY:Berlin Meeting",
    "DTSTART;TZID=Europe/Berlin:20260617T120000",
    "DTEND;TZID=Europe/Berlin:20260617T130000",
    "END:VEVENT",
    "END:VCALENDAR"
  ].join("\r\n");

  const parsed = parseVevent(ics);
  assert.equal(parsed.isAllDay, false);
  // 12:00 Berlin (CEST = UTC+2) → 10:00 UTC
  assert.equal(parsed.startAt, 1781690400); // 2026-06-17T10:00:00Z
  assert.equal(parsed.endAt, 1781694000);   // 2026-06-17T11:00:00Z
});

test("parseVevent unescapes SUMMARY and DESCRIPTION", () => {
  const ics = [
    "BEGIN:VCALENDAR",
    "BEGIN:VEVENT",
    "UID:esc@apple",
    "SUMMARY:Hello\\, World",
    "DESCRIPTION:Line1\\nLine2",
    "DTSTART;VALUE=DATE:20260617",
    "END:VEVENT",
    "END:VCALENDAR"
  ].join("\r\n");

  const parsed = parseVevent(ics);
  assert.equal(parsed.summary, "Hello, World");
  assert.equal(parsed.description, "Line1\nLine2");
});

test("parseVevent returns null fields when VEVENT missing", () => {
  const parsed = parseVevent("BEGIN:VCALENDAR\r\nEND:VCALENDAR");
  assert.equal(parsed.uid, null);
  assert.equal(parsed.summary, null);
  assert.equal(parsed.isAllDay, false);
});

test("parseVtodo extracts all-day DUE date", () => {
  const ics = [
    "BEGIN:VCALENDAR",
    "BEGIN:VTODO",
    "UID:due-allday@test",
    "SUMMARY:Task with date due",
    "STATUS:NEEDS-ACTION",
    "DUE;VALUE=DATE:20260620",
    "END:VTODO",
    "END:VCALENDAR"
  ].join("\r\n");

  const parsed = parseVtodo(ics);
  assert.equal(parsed.hasDue, true);
  assert.equal(parsed.dueDate, "2026-06-20");
  assert.equal(parsed.dueAt, null);
});

test("parseVtodo extracts UTC datetime DUE", () => {
  const ics = [
    "BEGIN:VCALENDAR",
    "BEGIN:VTODO",
    "UID:due-utc@test",
    "SUMMARY:Task with timed due",
    "STATUS:NEEDS-ACTION",
    "DUE:20260620T140000Z",
    "END:VTODO",
    "END:VCALENDAR"
  ].join("\r\n");

  const parsed = parseVtodo(ics);
  assert.equal(parsed.hasDue, true);
  assert.equal(parsed.dueDate, null);
  // 2026-06-20T14:00:00Z
  assert.equal(parsed.dueAt, Math.floor(Date.parse("2026-06-20T14:00:00Z") / 1000));
});

test("parseVtodo extracts TZID DUE datetime", () => {
  const ics = [
    "BEGIN:VCALENDAR",
    "BEGIN:VTODO",
    "UID:due-tzid@test",
    "SUMMARY:Task with TZID due",
    "STATUS:NEEDS-ACTION",
    "DUE;TZID=Europe/Berlin:20260620T160000",
    "END:VTODO",
    "END:VCALENDAR"
  ].join("\r\n");

  const parsed = parseVtodo(ics);
  assert.equal(parsed.hasDue, true);
  assert.equal(parsed.dueDate, null);
  // 16:00 Berlin CEST (UTC+2) → 14:00 UTC
  assert.equal(parsed.dueAt, Math.floor(Date.parse("2026-06-20T14:00:00Z") / 1000));
});

test("parseVtodo has hasDue=false when DUE is absent", () => {
  const ics = [
    "BEGIN:VCALENDAR",
    "BEGIN:VTODO",
    "UID:no-due@test",
    "SUMMARY:No due date",
    "STATUS:NEEDS-ACTION",
    "END:VTODO",
    "END:VCALENDAR"
  ].join("\r\n");

  const parsed = parseVtodo(ics);
  assert.equal(parsed.hasDue, false);
  assert.equal(parsed.dueDate, null);
  assert.equal(parsed.dueAt, null);
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
