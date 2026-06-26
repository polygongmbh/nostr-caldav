import { parseVtodo, parseVevent } from "./ics.js";
import {
  detectReportType,
  extractRequestedProps,
  extractSyncToken,
  filterIssuesByCalendarQuery,
  filterCalendarEventsByCalendarQuery,
  containsVeventFilter,
  projectCalendarData
} from "./caldav-query.js";

function normalizeEtagValue(value) {
  if (!value) return "";
  return String(value).trim().replace(/^W\//i, "");
}

function ifMatchSatisfied(ifMatch, currentEtag) {
  if (!ifMatch) return true;
  const normalizedCurrent = normalizeEtagValue(currentEtag);
  const candidates = String(ifMatch)
    .split(",")
    .map((v) => normalizeEtagValue(v))
    .filter(Boolean);

  if (candidates.includes("*")) return true;
  return candidates.includes(normalizedCurrent);
}

export function selectIssuesForSync({ currentToken, requestedToken, issues }) {
  if (requestedToken && requestedToken >= currentToken) {
    return [];
  }
  return issues;
}

export function runReportQuery({ issues, calendarEvents = [], reportBody, syncToken }) {
  const type = detectReportType(reportBody);

  if (type === "sync-collection") {
    const requestedToken = extractSyncToken(reportBody);
    const filteredIssues = selectIssuesForSync({ currentToken: syncToken, requestedToken, issues });
    const filteredCalEvents = requestedToken && requestedToken >= syncToken ? [] : calendarEvents;
    return { type, issues: filteredIssues, calendarEvents: filteredCalEvents };
  }

  if (type === "calendar-query") {
    const wantsVevent = containsVeventFilter(reportBody);
    const wantsVtodo = !wantsVevent;
    const requestedProps = extractRequestedProps(reportBody);

    const filteredIssues = wantsVtodo ? filterIssuesByCalendarQuery(issues, reportBody) : [];
    const filteredCalEvents = wantsVevent ? filterCalendarEventsByCalendarQuery(calendarEvents, reportBody) : [];

    const results = [
      ...filteredIssues.map((issue) => ({ issue, projection: projectCalendarData(issue, requestedProps) })),
      ...filteredCalEvents.map((calEvent) => ({ calendarEvent: calEvent, projection: projectCalendarData(calEvent, requestedProps) }))
    ];
    return { type, results };
  }

  return { type, issues, calendarEvents };
}

export async function processVtodoPut({ db, syncService, uid, ifMatch, body, authContext = null }) {
  const issue = db.getIssueByUid(uid);
  if (!issue) {
    db.logSync({
      direction: "caldav_to_nostr",
      eventId: uid,
      action: "put_rejected_not_found"
    });
    return { status: 404, error: "Not found" };
  }

  const etagMatched = ifMatchSatisfied(ifMatch, issue.caldav_etag);
  if (!etagMatched) {
    // CalDAV clients can hold stale ETags while we ingest relay updates.
    // We only support status mutation in PUT, so we can safely continue.
    db.logSync({
      direction: "caldav_to_nostr",
      eventId: issue.event_id,
      action: "put_etag_mismatch_ignored"
    });
  }

  const parsed = parseVtodo(body || "");
  if (!parsed.internalStatus) {
    db.logSync({
      direction: "caldav_to_nostr",
      eventId: issue.event_id,
      action: "put_rejected_invalid_status"
    });
    return { status: 400, error: "VTODO STATUS is required and must be supported" };
  }

  const update = db.updateStatusFromCaldav({ uid, internalStatus: parsed.internalStatus });

  if (update.changed) {
    try {
      await syncService.publishStatusFromCaldav(update.issue.event_id, update.issue.status, { authContext });
    } catch (error) {
      db.logSync({
        direction: "caldav_to_nostr",
        eventId: update.issue.event_id,
        action: "publish_failed",
        error: String(error)
      });
      return { status: 502, error: "Failed to publish status event to relays" };
    }
  }

  if (parsed.hasDue) {
    const newDueDate = parsed.dueDate || null;
    const newDueAt = parsed.dueAt ?? null;
    if (newDueDate !== (issue.due_date || null) || newDueAt !== (issue.due_at ?? null)) {
      try {
        await syncService.updateDueDateFromCaldav(issue.event_id, { dueDate: newDueDate, dueAt: newDueAt }, { authContext });
      } catch (error) {
        db.logSync({
          direction: "caldav_to_nostr",
          eventId: issue.event_id,
          action: "publish_due_date_failed",
          error: String(error)
        });
      }
    }
  }

  const refreshed = db.getIssueByUid(uid);
  return {
    status: 204,
    etag: refreshed.caldav_etag,
    changed: Boolean(update.changed)
  };
}

export async function processVeventUpdate({ db, syncService, uid, body, calendarTags = [], authContext = null }) {
  const existing = db.getCalendarEventByUid(uid);
  if (!existing) {
    return { status: 404, error: "Not found" };
  }

  const parsed = parseVevent(body || "");
  const summary = String(parsed.summary || "").trim();
  const description = String(parsed.description || "").trim();

  if (!summary && !description) {
    db.logSync({ direction: "caldav_to_nostr", eventId: uid, action: "vevent_update_missing_content" });
    return { status: 400, error: "VEVENT SUMMARY is required" };
  }

  // CalDAV PUT must send the full VEVENT, but some clients omit unchanged datetime fields
  // or use formats that fail to parse. Fall back to the existing DB values so the relay
  // always gets a valid NIP-52 event with a start tag.
  // Use isFinite() guard: ?? only catches null/undefined, not NaN from failed date parsing.
  const validNum = (v) => (typeof v === "number" && isFinite(v) ? v : null);
  const resolvedIsAllDay = parsed.startDate != null ? true : validNum(parsed.startAt) != null ? false : Boolean(existing.is_all_day);
  const resolvedStartDate = parsed.startDate ?? existing.start_date ?? null;
  const resolvedEndDate = parsed.endDate ?? existing.end_date ?? null;
  const resolvedStartAt = validNum(parsed.startAt) ?? (resolvedIsAllDay ? null : existing.start_at) ?? null;
  const resolvedEndAt = validNum(parsed.endAt) ?? (resolvedIsAllDay ? null : existing.end_at) ?? null;
  const resolvedStartTzid = parsed.startTzid ?? existing.start_tzid ?? null;
  const resolvedEndTzid = parsed.endTzid ?? existing.end_tzid ?? null;

  try {
    const updated = await syncService.updateCalendarEventFromCaldav({
      dTag: existing.d_tag,
      caldavUid: uid,
      summary: summary || description.slice(0, 180),
      description,
      location: parsed.location !== undefined ? parsed.location : (existing.location || null),
      labels: Array.isArray(parsed.labels) && parsed.labels.length > 0 ? parsed.labels : [],
      isAllDay: resolvedIsAllDay,
      startDate: resolvedStartDate,
      endDate: resolvedEndDate,
      startAt: resolvedStartAt,
      endAt: resolvedEndAt,
      startTzid: resolvedStartTzid,
      endTzid: resolvedEndTzid,
      tagNames: calendarTags
    }, { authContext });

    if (updated?.skipped) {
      return { status: 502, error: "Failed to publish updated calendar event to relays" };
    }

    const calEvent = db.getCalendarEventByUid(uid);
    return { status: 204, etag: calEvent?.caldav_etag || null, eventId: updated.event.id };
  } catch (error) {
    db.logSync({ direction: "caldav_to_nostr", eventId: uid, action: "update_calendar_event_failed", error: String(error) });
    return { status: 502, error: "Failed to publish updated calendar event to relays" };
  }
}

export async function processVeventCreate({ db, syncService, uid, body, calendarTags = [], authContext = null }) {
  const existing = db.getCalendarEventByUid(uid);
  if (existing) {
    db.logSync({ direction: "caldav_to_nostr", eventId: uid, action: "vevent_create_conflict" });
    return { status: 409, error: "UID already exists" };
  }

  const parsed = parseVevent(body || "");
  const summary = String(parsed.summary || "").trim();
  const description = String(parsed.description || "").trim();

  if (!summary && !description) {
    db.logSync({ direction: "caldav_to_nostr", eventId: uid, action: "vevent_create_missing_content" });
    return { status: 400, error: "VEVENT SUMMARY is required" };
  }

  try {
    const created = await syncService.createCalendarEventFromCaldav({
      uid,
      summary: summary || description.slice(0, 180),
      description,
      location: parsed.location || null,
      labels: Array.isArray(parsed.labels) ? parsed.labels : [],
      isAllDay: Boolean(parsed.isAllDay),
      startDate: parsed.startDate || null,
      endDate: parsed.endDate || null,
      startAt: parsed.startAt ?? null,
      endAt: parsed.endAt ?? null,
      startTzid: parsed.startTzid || null,
      endTzid: parsed.endTzid || null,
      tagNames: calendarTags
    }, { authContext });

    if (created?.skipped) {
      return { status: 502, error: "Failed to publish calendar event to relays" };
    }

    const calEvent = db.getCalendarEventByUid(uid);
    return { status: 201, etag: calEvent?.caldav_etag || null, eventId: created.event.id };
  } catch (error) {
    db.logSync({ direction: "caldav_to_nostr", eventId: uid, action: "create_calendar_event_failed", error: String(error) });
    return { status: 502, error: "Failed to publish calendar event to relays" };
  }
}

export async function processVtodoCreate({ db, syncService, uid, body, channelTag = null, authContext = null }) {
  const existing = db.getIssueByUid(uid);
  if (existing) {
    return { status: 409, error: "UID already exists" };
  }

  const parsed = parseVtodo(body || "");
  const summary = String(parsed.summary || "").trim();
  const description = String(parsed.description || "").trim();
  const labels = Array.isArray(parsed.categories) ? parsed.categories : [];
  const status = parsed.internalStatus || "open";

  if (!summary && !description) {
    db.logSync({
      direction: "caldav_to_nostr",
      eventId: uid,
      action: "put_rejected_missing_content"
    });
    return { status: 400, error: "VTODO SUMMARY or DESCRIPTION is required" };
  }

  try {
    const created = await syncService.createIssueFromCaldav({
      uid,
      summary: summary || description.slice(0, 180),
      description,
      labels,
      channelTag,
      status,
      dueDate: parsed.dueDate || null,
      dueAt: parsed.dueAt ?? null
    }, { authContext });

    if (created?.skipped) {
      return { status: 502, error: "Failed to publish issue event to relays" };
    }

    const issue = db.getIssueByUid(uid);
    return {
      status: 201,
      etag: issue?.caldav_etag || null,
      eventId: created.event.id
    };
  } catch (error) {
    db.logSync({
      direction: "caldav_to_nostr",
      eventId: uid,
      action: "create_issue_failed",
      error: String(error)
    });
    return { status: 502, error: "Failed to publish issue event to relays" };
  }
}
