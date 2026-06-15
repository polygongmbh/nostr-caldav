import Database from "better-sqlite3";
import { statusKindToInternal, CALENDAR_EVENT_DATE_KIND } from "./status.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS issues (
  event_id        TEXT PRIMARY KEY,
  pubkey          TEXT NOT NULL,
  relay_url       TEXT,
  subject         TEXT,
  body            TEXT,
  labels          TEXT,
  channel_tags    TEXT,
  mention_pubkeys TEXT,
  mention_handles TEXT,
  parent_event_id TEXT,
  created_at      INTEGER,
  status          TEXT DEFAULT 'open',
  caldav_uid      TEXT UNIQUE,
  caldav_etag     TEXT,
  sequence        INTEGER DEFAULT 0,
  last_modified   INTEGER,
  nostr_updated   INTEGER,
  due_at          INTEGER,
  due_date        TEXT
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

CREATE TABLE IF NOT EXISTS calendar_events (
  event_id      TEXT PRIMARY KEY,
  pubkey        TEXT NOT NULL,
  kind          INTEGER NOT NULL,
  relay_url     TEXT,
  d_tag         TEXT NOT NULL DEFAULT '',
  title         TEXT,
  description   TEXT,
  start_at      INTEGER,
  end_at        INTEGER,
  start_date    TEXT,
  end_date      TEXT,
  start_tzid    TEXT,
  end_tzid      TEXT,
  location      TEXT,
  is_all_day    INTEGER NOT NULL DEFAULT 0,
  labels        TEXT,
  created_at    INTEGER,
  caldav_uid    TEXT UNIQUE,
  caldav_etag   TEXT,
  sequence      INTEGER DEFAULT 0,
  last_modified INTEGER,
  nostr_updated INTEGER
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_cal_events_addr ON calendar_events (pubkey, kind, d_tag);
`;

function nowUnix() {
  return Math.floor(Date.now() / 1000);
}

function mergeRelayUrls(existingJson, newUrl) {
  let arr;
  try {
    arr = JSON.parse(existingJson || "[]");
    if (!Array.isArray(arr)) arr = [];
  } catch {
    arr = [];
  }
  if (newUrl && !arr.includes(newUrl)) arr.push(newUrl);
  return JSON.stringify(arr);
}

function ensureColumn(db, table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!columns.some((entry) => entry.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

const ETAG_FORMAT_VERSION = "v2";

function etagFor(eventId, sequence) {
  return `\"${eventId}-${sequence}-${ETAG_FORMAT_VERSION}\"`;
}

function findFirstTag(tags, name) {
  return (tags || []).find((tag) => tag[0] === name)?.[1] || null;
}

function listTagValues(tags, name) {
  return (tags || []).filter((tag) => tag[0] === name).map((tag) => tag[1]);
}

function uniq(values) {
  return Array.from(new Set((values || []).filter(Boolean)));
}

function normalizedText(value) {
  return String(value || "");
}

function findReferencedIssueId(tags) {
  return findFirstTag(tags, "e");
}

function findParentIssueId(tags) {
  const markerTag = (tags || []).find((tag) => tag[0] === "e" && (tag[3] === "parent" || tag[3] === "reply"));
  return markerTag?.[1] || null;
}

function deriveIssueSubject(tags, content) {
  const tagged = findFirstTag(tags, "subject");
  if (tagged && String(tagged).trim()) return String(tagged).trim();

  const firstLine = String(content || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);

  if (firstLine) return firstLine.slice(0, 180);
  return "(no subject)";
}

export function openDb(filePath) {
  const db = new Database(filePath);
  db.pragma("journal_mode = WAL");
  db.exec(SCHEMA);
  ensureColumn(db, "issues", "channel_tags", "TEXT");
  ensureColumn(db, "issues", "mention_pubkeys", "TEXT");
  ensureColumn(db, "issues", "mention_handles", "TEXT");
  ensureColumn(db, "issues", "parent_event_id", "TEXT");
  ensureColumn(db, "issues", "relay_urls", "TEXT");
  ensureColumn(db, "issues", "due_at", "INTEGER");
  ensureColumn(db, "issues", "due_date", "TEXT");
  ensureColumn(db, "calendar_events", "relay_urls", "TEXT");

  // Normalize calendar_events.labels to sorted JSON arrays for exact-match queries.
  db.transaction(() => {
    const rows = db.prepare("SELECT rowid, labels FROM calendar_events WHERE labels IS NOT NULL").all();
    const update = db.prepare("UPDATE calendar_events SET labels = ? WHERE rowid = ?");
    for (const row of rows) {
      try {
        const parsed = JSON.parse(row.labels || "[]");
        if (!Array.isArray(parsed)) continue;
        const sorted = parsed.map((v) => String(v || "").trim().toLowerCase()).filter(Boolean).sort();
        const normalized = JSON.stringify(sorted);
        if (normalized !== row.labels) update.run(normalized, row.rowid);
      } catch {}
    }
  })();

  // Migrate due dates from task-linked calendar events into issues.due_at / due_date.
  // Task-linked events use d_tag = "task-date-{issueId}-{type}" and are never shown
  // in Calendar; their date belongs on the VTODO instead.
  db.transaction(() => {
    const linked = db.prepare(
      "SELECT d_tag, start_at, start_date, is_all_day FROM calendar_events WHERE d_tag LIKE 'task-date-%'"
    ).all();
    const setDue = db.prepare(
      "UPDATE issues SET due_at = @due_at, due_date = @due_date WHERE event_id = @event_id AND due_at IS NULL AND due_date IS NULL"
    );
    for (const row of linked) {
      const match = String(row.d_tag || "").match(/^task-date-([0-9a-f]{64})-/);
      if (!match) continue;
      setDue.run({
        event_id: match[1],
        due_at: row.is_all_day ? null : (row.start_at || null),
        due_date: row.is_all_day ? (row.start_date || null) : null
      });
    }
  })();

  const getIssueByEventIdStmt = db.prepare("SELECT * FROM issues WHERE event_id = ?");
  const getIssueByUidStmt = db.prepare("SELECT * FROM issues WHERE caldav_uid = ?");
  const listIssuesStmt = db.prepare("SELECT * FROM issues ORDER BY created_at DESC");
  const issueHasSubtasksStmt = db.prepare("SELECT 1 FROM issues WHERE parent_event_id = ? LIMIT 1");
  const listDistinctChannelTagsStmt = db.prepare("SELECT channel_tags FROM issues");
  const listSyncLogStmt = db.prepare(
    "SELECT id, direction, event_id, action, timestamp, error FROM sync_log ORDER BY id DESC LIMIT ?"
  );

  const upsertIssueStmt = db.prepare(`
    INSERT INTO issues (
      event_id, pubkey, relay_url, relay_urls, subject, body, labels, created_at, status,
      channel_tags, mention_pubkeys, mention_handles, parent_event_id,
      caldav_uid, caldav_etag, sequence, last_modified, nostr_updated
    )
    VALUES (
      @event_id, @pubkey, @relay_url, @relay_urls, @subject, @body, @labels, @created_at, @status,
      @channel_tags, @mention_pubkeys, @mention_handles, @parent_event_id,
      @caldav_uid, @caldav_etag, @sequence, @last_modified, @nostr_updated
    )
    ON CONFLICT(event_id) DO UPDATE SET
      relay_url = excluded.relay_url,
      relay_urls = excluded.relay_urls,
      subject = excluded.subject,
      body = excluded.body,
      labels = excluded.labels,
      channel_tags = excluded.channel_tags,
      mention_pubkeys = excluded.mention_pubkeys,
      mention_handles = excluded.mention_handles,
      parent_event_id = excluded.parent_event_id,
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
  const updateUidByEventIdStmt = db.prepare(`
    UPDATE issues
    SET caldav_uid = @caldav_uid,
        sequence = @sequence,
        caldav_etag = @caldav_etag,
        last_modified = @last_modified
    WHERE event_id = @event_id
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

  function getConfigValue(key) {
    const row = getConfigStmt.get(key);
    return row ? row.value : null;
  }

  function setConfigValue(key, value) {
    setConfigStmt.run(key, String(value));
  }

  function logSync({ direction, eventId, action, error = null }) {
    db.prepare(
      "INSERT INTO sync_log (direction, event_id, action, timestamp, error) VALUES (?, ?, ?, ?, ?)"
    ).run(direction, eventId, action, nowUnix(), error);
  }

  function upsertIssueFromNostr(event, relayUrl) {
    const existing = getIssueByEventIdStmt.get(event.id);

    const subject = deriveIssueSubject(event.tags, event.content);
    const labels = listTagValues(event.tags, "label");
    const channelTags = uniq(listTagValues(event.tags, "t").map((value) => String(value || "").trim().toLowerCase()));
    const parentEventId = findParentIssueId(event.tags);
    const mentionPubkeys = uniq(
      listTagValues(event.tags, "p")
        .map((value) => String(value || "").trim().toLowerCase())
        .filter((value) => /^[0-9a-f]{64}$/.test(value))
    );
    const mentionHandles = uniq(
      (event.tags || [])
        .filter((tag) => tag[0] === "h" || tag[0] === "mention")
        .map((tag) => String(tag[1] || "").trim().toLowerCase())
    );
    const body = normalizedText(event.content);
    const labelsJson = JSON.stringify(labels);
    const channelTagsJson = JSON.stringify(channelTags);
    const mentionPubkeysJson = JSON.stringify(mentionPubkeys);
    const mentionHandlesJson = JSON.stringify(mentionHandles);

    if (existing) {
      const samePayload =
        normalizedText(existing.subject) === subject &&
        normalizedText(existing.body) === body &&
        normalizedText(existing.labels || "[]") === labelsJson &&
        normalizedText(existing.channel_tags || "[]") === channelTagsJson &&
        normalizedText(existing.mention_pubkeys || "[]") === mentionPubkeysJson &&
        normalizedText(existing.mention_handles || "[]") === mentionHandlesJson &&
        normalizedText(existing.parent_event_id) === normalizedText(parentEventId);

      // Avoid ETag churn on duplicate refetches of the exact same event payload.
      if (samePayload && Number(existing.nostr_updated || 0) >= Number(event.created_at || 0)) {
        // Still accumulate relay_urls even when content is unchanged.
        if (relayUrl) {
          const merged = mergeRelayUrls(existing.relay_urls, relayUrl);
          if (merged !== (existing.relay_urls || "[]")) {
            db.prepare("UPDATE issues SET relay_urls = ? WHERE event_id = ?").run(merged, event.id);
          }
        }
        return { changed: false, reason: "duplicate_issue_event" };
      }
    }

    const sequence = (existing?.sequence || 0) + 1;
    const caldavUid = existing?.caldav_uid || `${event.id}@nostr-issues`;
    const relayUrlsJson = mergeRelayUrls(existing?.relay_urls, relayUrl);

    upsertIssueStmt.run({
      event_id: event.id,
      pubkey: event.pubkey,
      relay_url: relayUrl,
      relay_urls: relayUrlsJson,
      subject,
      body,
      labels: labelsJson,
      channel_tags: channelTagsJson,
      mention_pubkeys: mentionPubkeysJson,
      mention_handles: mentionHandlesJson,
      parent_event_id: parentEventId,
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

    // If a task-linked calendar event arrived before this issue, pick up its due date now.
    const inserted = getIssueByEventIdStmt.get(event.id);
    if (inserted && inserted.due_at == null && inserted.due_date == null) {
      const pendingCalEv = db.prepare(
        "SELECT start_at, start_date, is_all_day FROM calendar_events WHERE d_tag LIKE ? LIMIT 1"
      ).get(`task-date-${event.id}-%`);
      if (pendingCalEv) {
        db.prepare(
          "UPDATE issues SET due_at = @due_at, due_date = @due_date WHERE event_id = @event_id"
        ).run({
          event_id: event.id,
          due_at: pendingCalEv.is_all_day ? null : (pendingCalEv.start_at || null),
          due_date: pendingCalEv.is_all_day ? (pendingCalEv.start_date || null) : null
        });
      }
    }
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
      relay_urls: issue.relay_urls || "[]",
      subject: issue.subject,
      body,
      labels: issue.labels || "[]",
      channel_tags: issue.channel_tags || "[]",
      mention_pubkeys: issue.mention_pubkeys || "[]",
      mention_handles: issue.mention_handles || "[]",
      parent_event_id: issue.parent_event_id || null,
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

  function setIssueUidFromCaldav({ eventId, uid }) {
    const issue = getIssueByEventIdStmt.get(eventId);
    if (!issue) {
      return { changed: false, reason: "unknown_issue" };
    }

    if (issue.caldav_uid === uid) {
      return { changed: false, issue, reason: "no_uid_change" };
    }

    const sequence = (issue.sequence || 0) + 1;
    updateUidByEventIdStmt.run({
      event_id: eventId,
      caldav_uid: uid,
      sequence,
      caldav_etag: etagFor(issue.event_id, sequence),
      last_modified: nowUnix()
    });

    bumpSyncToken();
    logSync({ direction: "caldav_to_nostr", eventId: eventId, action: "uid_mapped" });

    return {
      changed: true,
      issue: getIssueByEventIdStmt.get(eventId)
    };
  }

  function listIssuesFiltered({ pubkeys, labels, statuses, text, tags } = {}) {
    let query = "SELECT * FROM issues";
    const where = ["NOT EXISTS (SELECT 1 FROM issues child WHERE child.parent_event_id = issues.event_id)"];
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

    if (Array.isArray(tags) && tags.length > 0) {
      const clauses = tags.map((_, idx) => `channel_tags LIKE @tag_${idx}`);
      where.push(`(${clauses.join(" OR ")})`);
      tags.forEach((tag, idx) => {
        params[`tag_${idx}`] = `%\"${tag}\"%`;
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

  function upsertCalendarEventFromNostr(event, relayUrl) {
    const dTag = findFirstTag(event.tags, "d") || "";
    const titleTag = findFirstTag(event.tags, "title");
    const startTag = findFirstTag(event.tags, "start");
    const endTag = findFirstTag(event.tags, "end");
    const startTzid = findFirstTag(event.tags, "start_tzid");
    const endTzid = findFirstTag(event.tags, "end_tzid");
    const location = findFirstTag(event.tags, "location");
    const labels = uniq(listTagValues(event.tags, "t").map((v) => String(v || "").trim().toLowerCase())).sort();

    const isAllDay = event.kind === CALENDAR_EVENT_DATE_KIND ? 1 : 0;
    const startAt = isAllDay ? null : (startTag ? Number(startTag) : null);
    const endAt = isAllDay ? null : (endTag ? Number(endTag) : null);
    const startDate = isAllDay ? (startTag || null) : null;
    const endDate = isAllDay ? (endTag || null) : null;

    // Task-linked calendar events carry a due/scheduled date for a kind-1621 issue.
    // Detect them via the "e" tag with role "task" (set by Nodex) or the stable
    // d_tag pattern "task-date-{issueId}-{type}". These should update the issue's
    // due date and never appear as standalone calendar entries in the CalDAV Calendar.
    const taskRefTag = (event.tags || []).find(
      (tag) => tag[0] === "e" && tag[1] && tag[3] === "task"
    );
    const taskRefId = taskRefTag?.[1] || (() => {
      const m = dTag.match(/^task-date-([0-9a-f]{64})-/);
      return m ? m[1] : null;
    })();

    if (taskRefId) {
      const issue = getIssueByEventIdStmt.get(taskRefId);
      if (issue) {
        db.prepare(
          "UPDATE issues SET due_at = @due_at, due_date = @due_date WHERE event_id = @event_id"
        ).run({
          event_id: taskRefId,
          due_at: isAllDay ? null : (startAt || null),
          due_date: isAllDay ? (startDate || null) : null
        });
        bumpSyncToken();
        logSync({ direction: "nostr_to_caldav", eventId: event.id, action: "set_issue_due_date" });
      }
      // Still store in calendar_events so the date isn't lost if the issue arrives later,
      // but listCalendarEventsFiltered excludes task-date-* d_tags from Calendar.
    }

    const title = titleTag || deriveIssueSubject(event.tags, event.content);
    const description = normalizedText(event.content);

    const existing = db.prepare(
      "SELECT * FROM calendar_events WHERE pubkey = ? AND kind = ? AND d_tag = ?"
    ).get(event.pubkey, event.kind, dTag);

    if (existing && (existing.nostr_updated || 0) >= (event.created_at || 0)) {
      // Still accumulate relay_urls even when content is stale/unchanged.
      if (relayUrl) {
        const merged = mergeRelayUrls(existing.relay_urls, relayUrl);
        if (merged !== (existing.relay_urls || "[]")) {
          db.prepare("UPDATE calendar_events SET relay_urls = ? WHERE pubkey = ? AND kind = ? AND d_tag = ?")
            .run(merged, event.pubkey, event.kind, dTag);
        }
      }
      return { changed: false, reason: "stale_calendar_event" };
    }

    const sequence = (existing?.sequence || 0) + 1;
    const caldavUid = existing?.caldav_uid || `${event.id}@nostr-calendar`;
    const relayUrlsJson = mergeRelayUrls(existing?.relay_urls, relayUrl);

    if (existing) {
      db.prepare(`
        UPDATE calendar_events SET
          event_id = @event_id, relay_url = @relay_url, relay_urls = @relay_urls,
          title = @title, description = @description,
          start_at = @start_at, end_at = @end_at,
          start_date = @start_date, end_date = @end_date,
          start_tzid = @start_tzid, end_tzid = @end_tzid,
          location = @location, labels = @labels,
          caldav_etag = @caldav_etag, sequence = @sequence,
          last_modified = @last_modified, nostr_updated = @nostr_updated
        WHERE pubkey = @pubkey AND kind = @kind AND d_tag = @d_tag
      `).run({
        event_id: event.id,
        relay_url: relayUrl,
        relay_urls: relayUrlsJson,
        title, description,
        start_at: startAt, end_at: endAt,
        start_date: startDate, end_date: endDate,
        start_tzid: startTzid, end_tzid: endTzid,
        location,
        labels: JSON.stringify(labels),
        caldav_etag: etagFor(event.id, sequence),
        sequence,
        last_modified: nowUnix(),
        nostr_updated: event.created_at,
        pubkey: event.pubkey,
        kind: event.kind,
        d_tag: dTag
      });
    } else {
      db.prepare(`
        INSERT INTO calendar_events (
          event_id, pubkey, kind, relay_url, relay_urls, d_tag,
          title, description,
          start_at, end_at, start_date, end_date,
          start_tzid, end_tzid, location, is_all_day, labels,
          created_at, caldav_uid, caldav_etag, sequence, last_modified, nostr_updated
        ) VALUES (
          @event_id, @pubkey, @kind, @relay_url, @relay_urls, @d_tag,
          @title, @description,
          @start_at, @end_at, @start_date, @end_date,
          @start_tzid, @end_tzid, @location, @is_all_day, @labels,
          @created_at, @caldav_uid, @caldav_etag, @sequence, @last_modified, @nostr_updated
        )
      `).run({
        event_id: event.id,
        pubkey: event.pubkey,
        kind: event.kind,
        relay_url: relayUrl,
        relay_urls: relayUrlsJson,
        d_tag: dTag,
        title, description,
        start_at: startAt, end_at: endAt,
        start_date: startDate, end_date: endDate,
        start_tzid: startTzid, end_tzid: endTzid,
        location,
        is_all_day: isAllDay,
        labels: JSON.stringify(labels),
        created_at: event.created_at,
        caldav_uid: caldavUid,
        caldav_etag: etagFor(event.id, sequence),
        sequence,
        last_modified: nowUnix(),
        nostr_updated: event.created_at
      });
    }

    bumpSyncToken();
    logSync({ direction: "nostr_to_caldav", eventId: event.id, action: "upsert_calendar_event" });
    return { changed: true, eventId: event.id };
  }

  function getCalendarEventByUid(uid) {
    return db.prepare("SELECT * FROM calendar_events WHERE caldav_uid = ?").get(uid);
  }

  function getCalendarEventByEventId(eventId) {
    return db.prepare("SELECT * FROM calendar_events WHERE event_id = ?").get(eventId);
  }

  function listCalendarEventsFiltered({ pubkeys, tags, exactTags } = {}) {
    let query = "SELECT * FROM calendar_events";
    // Task-linked events (d_tag = "task-date-{issueId}-{type}") are represented as
    // VTODOs with a DUE date on the issue side — never expose them as Calendar VEVENTs.
    const where = ["d_tag NOT LIKE 'task-date-%'"];
    const params = {};

    if (Array.isArray(pubkeys) && pubkeys.length > 0) {
      const names = pubkeys.map((_, idx) => `pubkey_${idx}`);
      where.push(`pubkey IN (${names.map((n) => `@${n}`).join(",")})`);
      names.forEach((name, idx) => { params[name] = pubkeys[idx]; });
    }

    if (exactTags !== undefined) {
      const sorted = [...(Array.isArray(exactTags) ? exactTags : [])].sort();
      if (sorted.length === 0) {
        where.push("(labels IS NULL OR labels = '[]' OR labels = '')");
      } else {
        params.exact_labels = JSON.stringify(sorted);
        where.push("labels = @exact_labels");
      }
    } else if (Array.isArray(tags) && tags.length > 0) {
      const clauses = tags.map((_, idx) => `labels LIKE @tag_${idx}`);
      where.push(`(${clauses.join(" OR ")})`);
      tags.forEach((tag, idx) => { params[`tag_${idx}`] = `%"${tag}"%`; });
    }

    if (where.length > 0) {
      query += ` WHERE ${where.join(" AND ")}`;
    }

    query += " ORDER BY COALESCE(start_at, 0) DESC, start_date DESC";
    return db.prepare(query).all(params);
  }

  function listDistinctCalendarEventTagCombinations() {
    const rows = db.prepare("SELECT DISTINCT labels FROM calendar_events WHERE labels IS NOT NULL AND d_tag NOT LIKE 'task-date-%'").all();
    const seen = new Set();
    const result = [];
    for (const row of rows) {
      try {
        const parsed = JSON.parse(row.labels || "[]");
        if (!Array.isArray(parsed)) continue;
        const sorted = parsed.map((v) => String(v || "").trim().toLowerCase()).filter(Boolean).sort();
        const key = JSON.stringify(sorted);
        if (seen.has(key)) continue;
        seen.add(key);
        result.push(sorted);
      } catch {}
    }
    return result.sort((a, b) => {
      const aKey = a.join("\x00");
      const bKey = b.join("\x00");
      return aKey < bKey ? -1 : aKey > bKey ? 1 : 0;
    });
  }

  function listDistinctChannelTags() {
    const out = new Set();
    for (const row of listDistinctChannelTagsStmt.all()) {
      let tags = [];
      try {
        tags = JSON.parse(row.channel_tags || "[]");
      } catch {
        tags = [];
      }
      for (const tag of tags) {
        const value = String(tag || "").trim().toLowerCase();
        if (value) out.add(value);
      }
    }
    return Array.from(out).sort();
  }

  function listDistinctIssuePubkeys() {
    return db.prepare("SELECT DISTINCT pubkey FROM issues WHERE pubkey IS NOT NULL").all().map((r) => r.pubkey);
  }

  function listDistinctCalendarEventPubkeys() {
    return db.prepare("SELECT DISTINCT pubkey FROM calendar_events WHERE pubkey IS NOT NULL").all().map((r) => r.pubkey);
  }

  function listIssueEventIdsMissingChannelTags(limit = 1000) {
    const n = Math.max(1, Math.min(Number(limit) || 1000, 10000));
    const rows = db
      .prepare(
        "SELECT event_id FROM issues WHERE channel_tags IS NULL OR channel_tags = '' OR channel_tags = '[]' LIMIT ?"
      )
      .all(n);
    return rows.map((row) => row.event_id);
  }

  function listIssueEventIds(limit = 5000) {
    const n = Math.max(1, Math.min(Number(limit) || 5000, 10000));
    const rows = db.prepare("SELECT event_id FROM issues ORDER BY created_at DESC LIMIT ?").all(n);
    return rows.map((row) => row.event_id);
  }

  return {
    raw: db,
    getIssueByUid: (uid) => getIssueByUidStmt.get(uid),
    getIssueByEventId: (eventId) => getIssueByEventIdStmt.get(eventId),
    issueHasSubtasks: (eventId) => Boolean(issueHasSubtasksStmt.get(eventId)),
    listIssues: () => listIssuesStmt.all(),
    listDistinctChannelTags,
    listDistinctIssuePubkeys,
    listDistinctCalendarEventPubkeys,
    listIssueEventIdsMissingChannelTags,
    listIssueEventIds,
    listSyncLog: (limit = 50) => {
      const n = Math.max(1, Math.min(Number(limit) || 50, 500));
      return listSyncLogStmt.all(n);
    },
    listIssuesFiltered,
    getConfigValue,
    setConfigValue,
    getSyncToken,
    upsertIssueFromNostr,
    applyStatusEventFromNostr,
    applyCommentEventFromNostr,
    updateStatusFromCaldav,
    setIssueUidFromCaldav,
    upsertCalendarEventFromNostr,
    getCalendarEventByUid,
    getCalendarEventByEventId,
    listCalendarEventsFiltered,
    listDistinctCalendarEventTagCombinations,
    bumpSyncToken,
    logSync,
    close: () => db.close()
  };
}
