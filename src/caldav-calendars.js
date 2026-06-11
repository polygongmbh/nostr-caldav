function normalizeStoredRelayUrl(value) {
  return String(value || "").trim().toLowerCase().replace(/\/+$/, "") || null;
}

function relayMatchesFilter(relayUrls, relayUrl, relayFilter) {
  try {
    const arr = JSON.parse(relayUrls || "[]");
    if (Array.isArray(arr) && arr.some((u) => normalizeStoredRelayUrl(u) === relayFilter)) return true;
  } catch {}
  return normalizeStoredRelayUrl(relayUrl) === relayFilter;
}

function sanitizeId(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

function uniqueById(calendars) {
  const seen = new Set();
  const out = [];
  for (const cal of calendars) {
    if (!cal?.id || seen.has(cal.id)) continue;
    seen.add(cal.id);
    out.push(cal);
  }
  return out;
}

function jsonList(raw) {
  try {
    const parsed = JSON.parse(raw || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function normalizeHandle(value) {
  return String(value || "").trim().toLowerCase();
}

// Builds issue/task calendars only. Unchanged from original.
export function buildPrincipalCalendars(principal, trackedPubkeys, options = {}) {
  const includeAutoPubkeyCalendars = options.includeAutoPubkeyCalendars !== false;
  const channelTags = Array.isArray(options.channelTags) ? options.channelTags : [];

  const autoPubkeyCalendars = includeAutoPubkeyCalendars
    ? (trackedPubkeys || []).map((pubkey) => ({
        id: `pubkey-${pubkey.slice(0, 12)}`,
        name: `Issues by ${pubkey.slice(0, 12)}`,
        filter: { pubkeys: [pubkey] }
      }))
    : [];

  const configuredCalendars = (principal.calendars || []).map((cal) => ({
    id: sanitizeId(cal.id || cal.name),
    name: cal.name || cal.id || "Filtered",
    filter: {
      pubkeys: cal.pubkeys || [],
      labels: cal.labels || [],
      statuses: cal.statuses || [],
      text: cal.text || null
    }
  }));

  const channelCalendars = channelTags.map((tag) => ({
    id: `channel-${sanitizeId(tag)}`,
    name: `#${tag}`,
    filter: { tags: [tag] },
    channelTag: tag
  }));

  return uniqueById([
    ...channelCalendars,
    ...autoPubkeyCalendars,
    ...configuredCalendars
  ]);
}

// Builds calendar-event calendars from distinct tag combinations.
// Completely separate from issue calendars.
export function buildCalendarEventCals(calendarEventCombos) {
  if (!Array.isArray(calendarEventCombos)) return [];
  return calendarEventCombos.map((combo) => {
    const sorted = [...combo].sort();
    const name = sorted.length > 0 ? sorted.map((t) => `#${t}`).join(" ") : "Other Events";
    const id = sorted.length > 0 ? `calev-${sorted.map(sanitizeId).join("-")}` : "calev-other";
    return {
      id,
      name,
      filter: { exactTags: sorted },
      isCalendarEventCalendar: true
    };
  });
}

export function findCalendarForPrincipal(principal, trackedPubkeys, calendarId, options = {}) {
  const calendars = buildPrincipalCalendars(principal, trackedPubkeys, options);
  const found = calendars.find((cal) => cal.id === calendarId);
  if (found) return found;

  // Check calendar-event calendars separately.
  const calEvCals = buildCalendarEventCals(options.calendarEventCombos || []);
  const foundCalEv = calEvCals.find((cal) => cal.id === calendarId);
  if (foundCalEv) return foundCalEv;

  if (calendarId === "other-tasks" && options.db) {
    const visible = applyListVisibilityRules(options.db, principal, calendars);
    const otherTasks = visible.find((c) => c.id === "other-tasks");
    if (otherTasks) return otherTasks;
  }

  // Compatibility fallback for clients with cached legacy calendar IDs.
  if (calendarId === "nostr-issues") {
    return {
      id: "nostr-issues",
      name: "Your Issues (Legacy)",
      filter: {}
    };
  }

  return null;
}

export const SMALL_LIST_THRESHOLD = 5;

export function listIssuesForCalendar(db, calendar) {
  if (calendar?.isOtherTasks && Array.isArray(calendar.collectedCalendars)) {
    const seen = new Set();
    const result = [];
    for (const col of calendar.collectedCalendars) {
      for (const issue of db.listIssuesFiltered(col.filter || {})) {
        if (!seen.has(issue.event_id)) {
          seen.add(issue.event_id);
          result.push(issue);
        }
      }
    }
    return result;
  }
  return db.listIssuesFiltered(calendar?.filter || {});
}

// Only returns events for dedicated calendar-event calendars (isCalendarEventCalendar: true).
// Issue/channel calendars return [] — events appear once in their exact-tag calendar only.
export function listCalendarEventsForCalendar(db, calendar) {
  if (typeof db?.listCalendarEventsFiltered !== "function") return [];
  if (!calendar?.isCalendarEventCalendar) return [];
  return db.listCalendarEventsFiltered(calendar?.filter || {});
}

export function calendarEventVisibleToPrincipal(calEvent, principal) {
  if (principal?.relayFilter) {
    if (!relayMatchesFilter(calEvent?.relay_urls, calEvent?.relay_url, principal.relayFilter)) return false;
  }
  return true;
}

function visibleIssuesForCalendar(db, principal, calendar) {
  return (listIssuesForCalendar(db, calendar) || []).filter((issue) => {
    if (db.issueHasSubtasks?.(issue.event_id)) return false;
    return issueVisibleToPrincipal(issue, principal, {
      getIssueByEventId: db?.getIssueByEventId?.bind(db)
    });
  });
}

// Unchanged from original — issue-centric only, knows nothing about calev calendars.
export function applyListVisibilityRules(db, principal, calendars) {
  const large = [];
  const small = [];

  for (const calendar of calendars || []) {
    const issues = visibleIssuesForCalendar(db, principal, calendar);
    const hasOpenIssues = issues.some((i) => i.status === "open");
    if (!hasOpenIssues) continue;

    if (issues.length > SMALL_LIST_THRESHOLD) {
      large.push(calendar);
    } else {
      small.push(calendar);
    }
  }

  if (small.length === 0) return large;

  return [
    ...large,
    {
      id: "other-tasks",
      name: "Other Tasks",
      isOtherTasks: true,
      collectedCalendars: small,
      filter: {}
    }
  ];
}

export function issueVisibleInCalendar(issue, calendar) {
  const filter = calendar?.filter || {};

  if (Array.isArray(filter.pubkeys) && filter.pubkeys.length > 0 && !filter.pubkeys.includes(issue.pubkey)) {
    return false;
  }

  if (Array.isArray(filter.statuses) && filter.statuses.length > 0 && !filter.statuses.includes(issue.status)) {
    return false;
  }

  if (Array.isArray(filter.labels) && filter.labels.length > 0) {
    const labels = JSON.parse(issue.labels || "[]");
    if (!filter.labels.some((label) => labels.includes(label))) {
      return false;
    }
  }

  if (filter.text) {
    const text = String(filter.text).toLowerCase();
    const hay = `${issue.subject || ""} ${issue.body || ""}`.toLowerCase();
    if (!hay.includes(text)) {
      return false;
    }
  }

  return true;
}

export function issueVisibleToPrincipal(issue, principal, options = {}) {
  if (principal?.relayFilter) {
    if (!relayMatchesFilter(issue?.relay_urls, issue?.relay_url, principal.relayFilter)) return false;
  }

  const myPubkey = String(principal?.pubkeys?.[0] || "").trim().toLowerCase();
  const myHandle = normalizeHandle(principal?.username);
  const issueAuthor = String(issue?.pubkey || "").trim().toLowerCase();
  const mentionPubkeys = jsonList(issue?.mention_pubkeys).map((value) => String(value || "").trim().toLowerCase());
  const mentionHandles = jsonList(issue?.mention_handles).map(normalizeHandle);
  const hasAnyMentions = mentionPubkeys.length > 0 || mentionHandles.length > 0;
  const mentionsMe = (myPubkey && mentionPubkeys.includes(myPubkey)) || (myHandle && mentionHandles.includes(myHandle));
  const createdByMe = Boolean(myPubkey) && issueAuthor === myPubkey;

  if (mentionsMe) return true;
  if (createdByMe && !hasAnyMentions) return true;
  if (hasAnyMentions) return false;

  const parentId = String(issue?.parent_event_id || "").trim();
  const seen = options.seen instanceof Set ? options.seen : new Set();
  if (parentId && typeof options.getIssueByEventId === "function" && !seen.has(parentId)) {
    seen.add(parentId);
    const parent = options.getIssueByEventId(parentId);
    if (parent) {
      return issueVisibleToPrincipal(parent, principal, {
        ...options,
        seen
      });
    }
  }

  return false;
}
