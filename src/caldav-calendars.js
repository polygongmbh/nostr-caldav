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

export function buildPrincipalCalendars(principal, trackedPubkeys, options = {}) {
  const principalPubkeys = Array.isArray(principal.pubkeys) ? principal.pubkeys : [];
  const baseFilter = principalPubkeys.length > 0 ? { pubkeys: principalPubkeys } : {};
  const includeAutoPubkeyCalendars = options.includeAutoPubkeyCalendars !== false;

  const autoPubkeyCalendars = includeAutoPubkeyCalendars
    ? (trackedPubkeys || []).map((pubkey) => ({
    id: `pubkey-${pubkey.slice(0, 12)}`,
    name: `Issues by ${pubkey.slice(0, 12)}`,
    filter: {
      pubkeys: principalPubkeys.length > 0 && !principalPubkeys.includes(pubkey) ? [] : [pubkey]
    }
      }))
    : [];

  const configuredCalendars = (principal.calendars || []).map((cal) => ({
    id: sanitizeId(cal.id || cal.name),
    name: cal.name || cal.id || "Filtered",
    filter: {
      pubkeys:
        principalPubkeys.length > 0
          ? (cal.pubkeys || []).filter((p) => principalPubkeys.includes(p))
          : cal.pubkeys || [],
      labels: cal.labels || [],
      statuses: cal.statuses || [],
      text: cal.text || null
    }
  }));

  return uniqueById([
    {
      id: "nostr-issues",
      name: "Your Issues",
      filter: baseFilter
    },
    ...autoPubkeyCalendars,
    ...configuredCalendars
  ]);
}

export function findCalendarForPrincipal(principal, trackedPubkeys, calendarId, options = {}) {
  const calendars = buildPrincipalCalendars(principal, trackedPubkeys, options);
  return calendars.find((cal) => cal.id === calendarId) || null;
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
