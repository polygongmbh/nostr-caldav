import { parseVtodo } from "./ics.js";

function extractTagContent(xml, tagName) {
  const re = new RegExp(`<[^>]*${tagName}[^>]*>([\\s\\S]*?)<\\/[^>]*${tagName}>`, "i");
  const match = String(xml || "").match(re);
  return match ? match[1] : null;
}

function allTagContents(xml, tagName) {
  const re = new RegExp(`<[^>]*${tagName}[^>]*>([\\s\\S]*?)<\\/[^>]*${tagName}>`, "gi");
  const out = [];
  let match;
  while ((match = re.exec(String(xml || ""))) !== null) {
    out.push(match[1]);
  }
  return out;
}

function getAttr(fragment, attrName) {
  const re = new RegExp(`${attrName}="([^"]+)"`, "i");
  const m = String(fragment || "").match(re);
  return m ? m[1] : null;
}

function containsComponentFilter(xml) {
  return /<[^>]*comp-filter[^>]*name="VTODO"/i.test(String(xml || ""));
}

function parseTextMatchModes(fragment) {
  const textMatches = [];
  const re = /<[^>]*text-match([^>]*)>([\s\S]*?)<\/[^>]*text-match>/gi;
  let match;
  while ((match = re.exec(String(fragment || ""))) !== null) {
    const attrs = match[1] || "";
    textMatches.push({
      text: match[2] || "",
      negate: /negate-condition="yes"/i.test(attrs),
      matchType: (getAttr(attrs, "match-type") || "contains").toLowerCase(),
      collation: getAttr(attrs, "collation") || "i;unicode-casemap"
    });
  }
  return textMatches;
}

function parseTimeRange(fragment) {
  const m = String(fragment || "").match(/<[^>]*time-range([^>]*)\/>/i);
  if (!m) return null;

  const attrs = m[1] || "";
  const start = getAttr(attrs, "start");
  const end = getAttr(attrs, "end");
  return { start, end };
}

function normalizeText(value) {
  return String(value || "").toLowerCase();
}

function matchText(value, matcher) {
  const hay = normalizeText(value);
  const needle = normalizeText(matcher.text);

  let ok = false;
  switch (matcher.matchType) {
    case "equals":
      ok = hay === needle;
      break;
    case "starts-with":
      ok = hay.startsWith(needle);
      break;
    case "ends-with":
      ok = hay.endsWith(needle);
      break;
    case "contains":
    default:
      ok = hay.includes(needle);
      break;
  }

  return matcher.negate ? !ok : ok;
}

function toEpochFromIcal(icalDateTime) {
  if (!icalDateTime) return null;
  const m = String(icalDateTime).match(/^(\d{4})(\d{2})(\d{2})T?(\d{2})?(\d{2})?(\d{2})?Z?$/);
  if (!m) return null;

  const year = Number(m[1]);
  const month = Number(m[2]) - 1;
  const day = Number(m[3]);
  const hour = Number(m[4] || 0);
  const min = Number(m[5] || 0);
  const sec = Number(m[6] || 0);
  return Math.floor(Date.UTC(year, month, day, hour, min, sec) / 1000);
}

function matchTimeRange(issue, timeRange) {
  if (!timeRange) return true;

  const start = toEpochFromIcal(timeRange.start);
  const end = toEpochFromIcal(timeRange.end);
  const stamp = issue.last_modified || issue.created_at || 0;

  if (start !== null && stamp < start) return false;
  if (end !== null && stamp >= end) return false;
  return true;
}

function issuePropValue(issue, propName) {
  switch (propName) {
    case "UID":
      return issue.caldav_uid;
    case "STATUS":
      return issue.status;
    case "SUMMARY":
      return issue.subject;
    case "DESCRIPTION":
      return issue.body;
    case "CATEGORIES":
      return issue.labels || "";
    default:
      return "";
  }
}

function parsePropertyFilters(xml) {
  const matches = [];
  const re = /<[^>]*prop-filter([^>]*)>([\s\S]*?)<\/[^>]*prop-filter>/gi;
  let m;

  while ((m = re.exec(String(xml || ""))) !== null) {
    const attrs = m[1] || "";
    const body = m[2] || "";
    const name = (getAttr(attrs, "name") || "").toUpperCase();

    matches.push({
      name,
      textMatches: parseTextMatchModes(body),
      timeRange: parseTimeRange(body),
      isNotDefined: /<[^>]*is-not-defined\s*\/>/i.test(body)
    });
  }

  return matches;
}

export function detectReportType(xml) {
  if (/<[^>]*sync-collection/i.test(String(xml || ""))) return "sync-collection";
  if (/<[^>]*calendar-query/i.test(String(xml || ""))) return "calendar-query";
  return "unknown";
}

export function extractSyncToken(xml) {
  const value = extractTagContent(xml, "sync-token");
  if (!value) return null;
  const parts = value.trim().split(":");
  const token = Number(parts[parts.length - 1]);
  return Number.isFinite(token) ? token : null;
}

export function filterIssuesByCalendarQuery(issues, reportBody) {
  const xml = String(reportBody || "");

  if (!containsComponentFilter(xml)) {
    return [];
  }

  const propFilters = parsePropertyFilters(xml);
  if (propFilters.length === 0) {
    return issues;
  }

  return issues.filter((issue) => {
    for (const filter of propFilters) {
      const propValue = issuePropValue(issue, filter.name);
      const hasValue = propValue !== null && propValue !== undefined && String(propValue).length > 0;

      if (filter.isNotDefined && hasValue) {
        return false;
      }

      if (filter.timeRange && !matchTimeRange(issue, filter.timeRange)) {
        return false;
      }

      if (filter.textMatches.length > 0) {
        const ok = filter.textMatches.every((tm) => matchText(propValue, tm));
        if (!ok) {
          return false;
        }
      }
    }

    return true;
  });
}

export function extractRequestedProps(reportBody) {
  const props = [];
  const blocks = allTagContents(reportBody, "prop");

  for (const block of blocks) {
    const re = /<[^>]*([a-z-]+)\s*\/?>/gi;
    let m;
    while ((m = re.exec(block)) !== null) {
      const name = m[1];
      if (name) props.push(name.toLowerCase());
    }
  }

  return Array.from(new Set(props));
}

export function projectCalendarData(issue, requestedProps) {
  if (!Array.isArray(requestedProps) || requestedProps.length === 0) {
    return { includeCalendarData: true };
  }

  const includeCalendarData = requestedProps.includes("calendar-data");
  return { includeCalendarData };
}

export function extractStatusFromIcs(icsBody) {
  const parsed = parseVtodo(icsBody);
  return parsed.internalStatus;
}
