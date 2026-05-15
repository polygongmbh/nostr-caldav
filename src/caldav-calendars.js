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

export function buildPrincipalCalendars(principal, trackedPubkeys, options = {}) {
  const principalPubkeys = Array.isArray(principal.pubkeys) ? principal.pubkeys : [];
  const baseFilter = {};
  const includeAutoPubkeyCalendars = options.includeAutoPubkeyCalendars !== false;
  const channelTags = Array.isArray(options.channelTags) ? options.channelTags : [];

  const autoPubkeyCalendars = includeAutoPubkeyCalendars
    ? (trackedPubkeys || []).map((pubkey) => ({
    id: `pubkey-${pubkey.slice(0, 12)}`,
    name: `Issues by ${pubkey.slice(0, 12)}`,
      filter: {
      pubkeys: [pubkey]
    }
      }))
    : [];

  const configuredCalendars = (principal.calendars || []).map((cal) => ({
    id: sanitizeId(cal.id || cal.name),
    name: cal.name || cal.id || "Filtered",
    filter: {
      pubkeys:
        cal.pubkeys || [],
      labels: cal.labels || [],
      statuses: cal.statuses || [],
      text: cal.text || null
    }
  }));

  const channelCalendars = channelTags.map((tag) => ({
    id: `channel-${sanitizeId(tag)}`,
    name: `#${tag}`,
    filter: {
      ...baseFilter,
      tags: [tag]
    },
    channelTag: tag
  }));

  return uniqueById([
    {
      id: "nostr-issues",
      name: "Your Issues",
      filter: baseFilter
    },
    ...channelCalendars,
    ...autoPubkeyCalendars,
    ...configuredCalendars
  ]);
}

export function findCalendarForPrincipal(principal, trackedPubkeys, calendarId, options = {}) {
  const calendars = buildPrincipalCalendars(principal, trackedPubkeys, options);
  const found = calendars.find((cal) => cal.id === calendarId);
  if (found) return found;

  // Apple clients can keep previously discovered channel IDs and retry them later.
  // Accept channel-* paths even if the current discovery set changed to avoid 404 loops.
  if (String(calendarId || "").startsWith("channel-")) {
    const tag = String(calendarId).slice("channel-".length).trim().toLowerCase();
    if (tag) {
      return {
        id: calendarId,
        name: `#${tag}`,
        filter: { tags: [tag] },
        channelTag: tag
      };
    }
  }

  return null;
}

export function listIssuesForCalendar(db, calendar) {
  return db.listIssuesFiltered(calendar?.filter || {});
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
