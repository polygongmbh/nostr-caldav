import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS issues (
  event_id        TEXT PRIMARY KEY,
  pubkey          TEXT NOT NULL,
  relay_url       TEXT,
  subject         TEXT,
  body            TEXT,
  labels          TEXT,
  created_at      INTEGER,
  status          TEXT DEFAULT 'open',
  caldav_uid      TEXT UNIQUE,
  caldav_etag     TEXT,
  sequence        INTEGER DEFAULT 0,
  last_modified   INTEGER,
  nostr_updated   INTEGER
);

CREATE TABLE IF NOT EXISTS sync_log (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  direction       TEXT,
  event_id        TEXT,
  action          TEXT,
  timestamp       INTEGER,
  error           TEXT
);

CREATE TABLE IF NOT EXISTS config (
  key TEXT PRIMARY KEY,
  value TEXT
);
`;

export function openDb(filePath) {
  const db = new Database(filePath);
  db.pragma("journal_mode = WAL");
  db.exec(SCHEMA);

  const getIssueByEventIdStmt = db.prepare("SELECT * FROM issues WHERE event_id = ?");
  const getIssueByUidStmt = db.prepare("SELECT * FROM issues WHERE caldav_uid = ?");
  const listIssuesStmt = db.prepare("SELECT * FROM issues ORDER BY created_at DESC");

  const upsertIssueStmt = db.prepare(`
    INSERT INTO issues (
      event_id, pubkey, relay_url, subject, body, labels, created_at, status,
      caldav_uid, caldav_etag, sequence, last_modified, nostr_updated
    )
    VALUES (
      @event_id, @pubkey, @relay_url, @subject, @body, @labels, @created_at, @status,
      @caldav_uid, @caldav_etag, @sequence, @last_modified, @nostr_updated
    )
    ON CONFLICT(event_id) DO UPDATE SET
      relay_url = excluded.relay_url,
      subject = excluded.subject,
      body = excluded.body,
      labels = excluded.labels,
      status = excluded.status,
      caldav_etag = excluded.caldav_etag,
      sequence = excluded.sequence,
      last_modified = excluded.last_modified,
      nostr_updated = excluded.nostr_updated
  `);

  const setConfigStmt = db.prepare(`
    INSERT INTO config (key, value)
    VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `);

  const getConfigStmt = db.prepare("SELECT value FROM config WHERE key = ?");

  function getOrInitSyncToken() {
    const row = getConfigStmt.get("sync_token");
    if (row) return Number(row.value);
    setConfigStmt.run("sync_token", "1");
    return 1;
  }

  function bumpSyncToken() {
    const current = getOrInitSyncToken();
    const next = current + 1;
    setConfigStmt.run("sync_token", String(next));
    return next;
  }

  function getSyncToken() {
    return getOrInitSyncToken();
  }

  function logSync({ direction, eventId, action, error = null }) {
    db.prepare(
      "INSERT INTO sync_log (direction, event_id, action, timestamp, error) VALUES (?, ?, ?, ?, ?)"
    ).run(direction, eventId, action, Math.floor(Date.now() / 1000), error);
  }

  function upsertIssueFromNostr(event, relayUrl) {
    const existing = getIssueByEventIdStmt.get(event.id);

    const tags = event.tags || [];
    const subject = tags.find((t) => t[0] === "subject")?.[1] || "(no subject)";
    const labels = tags.filter((t) => t[0] === "label").map((t) => t[1]);
    const now = Math.floor(Date.now() / 1000);

    const sequence = (existing?.sequence || 0) + 1;
    const caldavUid = existing?.caldav_uid || `${event.id}@nostr-issues`;
    const etag = `\"${event.id}-${sequence}\"`;

    upsertIssueStmt.run({
      event_id: event.id,
      pubkey: event.pubkey,
      relay_url: relayUrl,
      subject,
      body: event.content || "",
      labels: JSON.stringify(labels),
      created_at: event.created_at,
      status: existing?.status || "open",
      caldav_uid: caldavUid,
      caldav_etag: etag,
      sequence,
      last_modified: now,
      nostr_updated: event.created_at
    });

    bumpSyncToken();
    logSync({ direction: "nostr_to_caldav", eventId: event.id, action: "upsert_issue" });
  }

  return {
    raw: db,
    getIssueByUid: (uid) => getIssueByUidStmt.get(uid),
    listIssues: () => listIssuesStmt.all(),
    getSyncToken,
    upsertIssueFromNostr,
    bumpSyncToken,
    logSync,
    close: () => db.close(),
    createUid: () => randomUUID()
  };
}
