import test from "node:test";
import assert from "node:assert/strict";
import {
  internalStatusToKind,
  normalizeVtodoStatus,
  statusKindToInternal,
  toInternalFromVtodo,
  toVtodoFromInternal
} from "../src/status.js";

test("status kind mapping from nostr to internal", () => {
  assert.equal(statusKindToInternal(1630), "open");
  assert.equal(statusKindToInternal(1631), "completed");
  assert.equal(statusKindToInternal(1632), "cancelled");
  assert.equal(statusKindToInternal(1633), "draft");
  assert.equal(statusKindToInternal(9999), null);
});

test("vtodo status mapping roundtrip", () => {
  assert.equal(toInternalFromVtodo("completed"), "completed");
  assert.equal(toInternalFromVtodo("NEEDS-ACTION"), "open");
  assert.equal(toInternalFromVtodo("CANCELLED"), "cancelled");
  assert.equal(toVtodoFromInternal("draft"), "IN-PROCESS");
  assert.equal(toVtodoFromInternal("nope"), "NEEDS-ACTION");
  assert.equal(internalStatusToKind("completed"), 1631);
});

test("status normalization uppercases and trims", () => {
  assert.equal(normalizeVtodoStatus("  in-process "), "IN-PROCESS");
});
