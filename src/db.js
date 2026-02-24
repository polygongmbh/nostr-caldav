import Database from "better-sqlite3";
import { statusKindToInternal } from "./status.js";

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

function nowUnix() {
  return Math.floor(Date.now() / 1000);
}

function etagFor(eventId, sequence) {
  return `\"${eventId}-${sequence}\"`;
}

function findFirstTag(tags, name) {
  return (tags || []).find((tag) => tag[0] === name)?.[1] || null;
}

function listTagValues(tags, name) {
  return (tags || []).filter((tag) => tag[0] === name).map((tag) => tag[1]);
}

function findReferencedIssueId(tags) {
  return findFirstTag(tags, "e");
}

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

  const updateStatusByEventIdStmt = db.prepare(`
    UPDATE issues
    SET status = @status,
        sequence = @sequence,
        caldav_etag = @caldav_etag,
        last_modified = @last_modified,
        nostr_updated = @nostr_updated
    WHERE event_id = @event_id
  `);

  const updateStatusByUidStmt = db.prepare(`
    UPDATE issues
    SET status = @status,
        sequence = @sequence,
        caldav_etag = @caldav_etag,
        last_modified = @last_modified
    WHERE caldav_uid = @caldav_uid
  `);

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
    ).run(direction, eventId, action, nowUnix(), error);
  }

  function upsertIssueFromNostr(event, relayUrl) {
    const existing = getIssueByEventIdStmt.get(event.id);

    const subject = findFirstTag(event.tags, "subject") || "(no subject)";
    const labels = listTagValues(event.tags, "label");
    const sequence = (existing?.sequence || 0) + 1;
    const caldavUid = existing?.caldav_uid || `${event.id}@nostr-issues`;

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
      caldav_etag: etagFor(event.id, sequence),
      sequence,
      last_modified: nowUnix(),
      nostr_updated: event.created_at
    });

    bumpSyncToken();
    logSync({ direction: "nostr_to_caldav", eventId: event.id, action: "upsert_issue" });
  }

  function applyStatusEventFromNostr(statusEvent) {
    const issueId = findReferencedIssueId(statusEvent.tags);
    const internalStatus = statusKindToInternal(statusEvent.kind);
    if (!issueId || !internalStatus) {
      return { changed: false, reason: "invalid_status_event" };
    }

    const issue = getIssueByEventIdStmt.get(issueId);
    if (!issue) {
      return { changed: false, reason: "unknown_issue" };
    }

    if ((issue.nostr_updated || 0) > statusEvent.created_at) {
      return { changed: false, reason: "stale_status_event" };
    }

    if (issue.status === internalStatus && (issue.nostr_updated || 0) === statusEvent.created_at) {
      return { changed: false, reason: "duplicate_status_event" };
    }

    const sequence = (issue.sequence || 0) + 1;
    updateStatusByEventIdStmt.run({
      event_id: issueId,
      status: internalStatus,
      sequence,
      caldav_etag: etagFor(issueId, sequence),
      last_modified: nowUnix(),
      nostr_updated: statusEvent.created_at
    });

    bumpSyncToken();
    logSync({ direction: "nostr_to_caldav", eventId: issueId, action: `status_${internalStatus}` });

    return { changed: true, eventId: issueId, status: internalStatus };
  }

  function applyCommentEventFromNostr(commentEvent) {
    const issueId = findReferencedIssueId(commentEvent.tags);
    if (!issueId) {
      return { changed: false, reason: "missing_issue_ref" };
    }

    const issue = getIssueByEventIdStmt.get(issueId);
    if (!issue) {
      return { changed: false, reason: "unknown_issue" };
    }

    const comment = String(commentEvent.content || "").trim();
    if (!comment) {
      return { changed: false, reason: "empty_comment" };
    }

    const marker = `[comment:${String(commentEvent.id || "").slice(0, 8)}] ${comment}`;
    const body = `${issue.body || ""}\n\n${marker}`.trim();
    const sequence = (issue.sequence || 0) + 1;

    upsertIssueStmt.run({
      event_id: issue.event_id,
      pubkey: issue.pubkey,
      relay_url: issue.relay_url,
      subject: issue.subject,
      body,
      labels: issue.labels || "[]",
      created_at: issue.created_at,
      status: issue.status || "open",
      caldav_uid: issue.caldav_uid,
      caldav_etag: etagFor(issue.event_id, sequence),
      sequence,
      last_modified: nowUnix(),
      nostr_updated: Math.max(issue.nostr_updated || 0, commentEvent.created_at || 0)
    });

    bumpSyncToken();
    logSync({ direction: "nostr_to_caldav", eventId: issue.event_id, action: "append_comment" });

    return { changed: true, eventId: issue.event_id };
  }

  function updateStatusFromCaldav({ uid, internalStatus }) {
    const issue = getIssueByUidStmt.get(uid);
    if (!issue) {
      return { changed: false, reason: "unknown_issue" };
    }

    if (issue.status === internalStatus) {
      return { changed: false, issue, reason: "no_status_change" };
    }

    const sequence = (issue.sequence || 0) + 1;
    updateStatusByUidStmt.run({
      caldav_uid: uid,
      status: internalStatus,
      sequence,
      caldav_etag: etagFor(issue.event_id, sequence),
      last_modified: nowUnix()
    });

    bumpSyncToken();
    logSync({ direction: "caldav_to_nostr", eventId: issue.event_id, action: `status_${internalStatus}` });

    return {
      changed: true,
      issue: getIssueByEventIdStmt.get(issue.event_id),
      previousStatus: issue.status
    };
  }

  function listIssuesFiltered({ pubkeys, labels, statuses, text } = {}) {
    let query = "SELECT * FROM issues";
    const where = [];
    const params = {};

    if (Array.isArray(pubkeys) && pubkeys.length > 0) {
      const names = pubkeys.map((_, idx) => `pubkey_${idx}`);
      where.push(`pubkey IN (${names.map((n) => `@${n}`).join(",")})`);
      names.forEach((name, idx) => {
        params[name] = pubkeys[idx];
      });
    }

    if (Array.isArray(statuses) && statuses.length > 0) {
      const names = statuses.map((_, idx) => `status_${idx}`);
      where.push(`status IN (${names.map((n) => `@${n}`).join(",")})`);
      names.forEach((name, idx) => {
        params[name] = statuses[idx];
      });
    }

    if (Array.isArray(labels) && labels.length > 0) {
      const clauses = labels.map((_, idx) => `labels LIKE @label_${idx}`);
      where.push(`(${clauses.join(" OR ")})`);
      labels.forEach((label, idx) => {
        params[`label_${idx}`] = `%\"${label}\"%`;
      });
    }

    if (text) {
      where.push("(subject LIKE @text OR body LIKE @text)");
      params.text = `%${text}%`;
    }

    if (where.length > 0) {
      query += ` WHERE ${where.join(" AND ")}`;
    }

    query += " ORDER BY created_at DESC";
    return db.prepare(query).all(params);
  }

  return {
    raw: db,
    getIssueByUid: (uid) => getIssueByUidStmt.get(uid),
    getIssueByEventId: (eventId) => getIssueByEventIdStmt.get(eventId),
    listIssues: () => listIssuesStmt.all(),
    listIssuesFiltered,
    getSyncToken,
    upsertIssueFromNostr,
    applyStatusEventFromNostr,
    applyCommentEventFromNostr,
    updateStatusFromCaldav,
    bumpSyncToken,
    logSync,
    close: () => db.close()
  };
}
