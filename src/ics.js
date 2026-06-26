import { nip19 } from "nostr-tools";
import { toInternalFromVtodo, toVtodoFromInternal, CALENDAR_EVENT_DATE_KIND } from "./status.js";

function escapeIcs(value = "") {
  return String(value)
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\n/g, "\\n");
}

function toUtcStamp(epochSeconds) {
  return new Date(epochSeconds * 1000).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

function toLocalStamp(epochSeconds, tzid) {
  const date = new Date(epochSeconds * 1000);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tzid,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hour12: false
  }).formatToParts(date);
  const p = Object.fromEntries(parts.map((x) => [x.type, x.value]));
  // V8 returns hour="24" with the day already advanced (e.g. day=27, hour=24 for midnight on the 27th).
  // Replace "24" with "00"; the day is already correct.
  const h = p.hour === "24" ? "00" : p.hour;
  return `${p.year}${p.month}${p.day}T${h}${p.minute}${p.second}`;
}

function unfoldIcsLines(raw) {
  const lines = String(raw || "").replace(/\r\n/g, "\n").split("\n");
  const out = [];

  for (const line of lines) {
    if (!line) continue;
    if ((line.startsWith(" ") || line.startsWith("\t")) && out.length > 0) {
      out[out.length - 1] += line.slice(1);
    } else {
      out.push(line);
    }
  }

  return out;
}

function parsePropName(line) {
  return line.split(":", 1)[0].split(";", 1)[0].toUpperCase();
}

function parsePropValue(line) {
  const idx = line.indexOf(":");
  if (idx < 0) return "";
  return line.slice(idx + 1).trim();
}

function parsePropFull(line) {
  const colonIdx = line.indexOf(":");
  if (colonIdx < 0) return { name: line.toUpperCase(), params: {}, value: "" };
  const namePart = line.slice(0, colonIdx);
  const value = line.slice(colonIdx + 1);
  const parts = namePart.split(";");
  const name = parts[0].toUpperCase();
  const params = {};
  for (let i = 1; i < parts.length; i++) {
    const eqIdx = parts[i].indexOf("=");
    if (eqIdx < 0) continue;
    params[parts[i].slice(0, eqIdx).toUpperCase()] = parts[i].slice(eqIdx + 1);
  }
  return { name, params, value };
}

function unescapeIcs(value) {
  return String(value || "")
    .replace(/\\n/gi, "\n")
    .replace(/\\;/g, ";")
    .replace(/\\,/g, ",")
    .replace(/\\\\/g, "\\");
}

function localToUtcUnix(icsLocal, tzid) {
  // icsLocal: "20260617T100000", tzid: "Europe/Berlin"
  // Convert a local datetime in a given IANA timezone to a Unix timestamp.
  const y = icsLocal.slice(0, 4), mo = icsLocal.slice(4, 6), d = icsLocal.slice(6, 8);
  const h = icsLocal.slice(9, 11), mi = icsLocal.slice(11, 13), s = icsLocal.slice(13, 15) || "00";
  const roughUtc = new Date(`${y}-${mo}-${d}T${h}:${mi}:${s}Z`);

  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: tzid, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false
    }).formatToParts(roughUtc);
    const p = Object.fromEntries(parts.map((x) => [x.type, x.value]));
    // V8 returns hour="24" with the day already advanced; replace with "00", day is correct.
    const hour = p.hour === "24" ? "00" : p.hour;
    const localInTzMs = Date.parse(`${p.year}-${p.month}-${p.day}T${hour}:${p.minute}:${p.second}Z`);
    return Math.floor((roughUtc.getTime() + (roughUtc.getTime() - localInTzMs)) / 1000);
  } catch {
    return Math.floor(roughUtc.getTime() / 1000);
  }
}

function parseDtProp(value, params) {
  const v = String(value || "").trim();
  // All-day: VALUE=DATE → YYYYMMDD
  if (params?.VALUE === "DATE" || /^\d{8}$/.test(v)) {
    return { isAllDay: true, date: `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}` };
  }
  // UTC: YYYYMMDDTHHMMSSz
  if (/^\d{8}T\d{6}Z$/i.test(v)) {
    const iso = `${v.slice(0,4)}-${v.slice(4,6)}-${v.slice(6,8)}T${v.slice(9,11)}:${v.slice(11,13)}:${v.slice(13,15)}Z`;
    return { isAllDay: false, at: Math.floor(Date.parse(iso) / 1000), tzid: null };
  }
  // Local with TZID: YYYYMMDDTHHmmss
  if (/^\d{8}T\d{6}$/i.test(v)) {
    if (params?.TZID) return { isAllDay: false, at: localToUtcUnix(v, params.TZID), tzid: params.TZID };
    // Float (no timezone): treat as UTC
    const iso = `${v.slice(0,4)}-${v.slice(4,6)}-${v.slice(6,8)}T${v.slice(9,11)}:${v.slice(11,13)}:${v.slice(13,15)}Z`;
    return { isAllDay: false, at: Math.floor(Date.parse(iso) / 1000), tzid: null };
  }
  return null;
}

function splitCategories(raw) {
  const src = String(raw || "");
  if (!src) return [];

  const out = [];
  let current = "";
  let escaped = false;
  for (const ch of src) {
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === ",") {
      const value = current.trim();
      if (value) out.push(value);
      current = "";
      continue;
    }
    current += ch;
  }
  const value = current.trim();
  if (value) out.push(value);
  return out;
}

export function parseVtodo(rawIcs) {
  const lines = unfoldIcsLines(rawIcs);
  let inVtodo = false;
  const props = {};
  let dueParsed = null;
  let hasDue = false;

  for (const line of lines) {
    const upper = line.toUpperCase();
    if (upper === "BEGIN:VTODO") {
      inVtodo = true;
      continue;
    }
    if (upper === "END:VTODO") {
      break;
    }
    if (!inVtodo) continue;

    const name = parsePropName(line);
    const value = parsePropValue(line);
    if (!props[name]) props[name] = value;

    if (name === "DUE" && !hasDue) {
      hasDue = true;
      const { params } = parsePropFull(line);
      dueParsed = parseDtProp(value, params);
    }
  }

  return {
    uid: props.UID || null,
    status: props.STATUS || null,
    summary: props.SUMMARY || null,
    description: props.DESCRIPTION || null,
    categories: splitCategories(props.CATEGORIES || ""),
    sequence: props.SEQUENCE ? Number(props.SEQUENCE) : null,
    internalStatus:
      toInternalFromVtodo(props.STATUS) ||
      (props.COMPLETED ? "completed" : null) ||
      (props["PERCENT-COMPLETE"] === "100" ? "completed" : null),
    hasDue,
    dueDate: dueParsed?.isAllDay ? dueParsed.date : null,
    dueAt: !dueParsed?.isAllDay && dueParsed?.at != null ? dueParsed.at : null
  };
}

export function parseVevent(rawIcs) {
  const lines = unfoldIcsLines(rawIcs);
  let inVevent = false;
  let summary = null, description = null, location = null, uid = null;
  let labels = [];
  let startDate = null, endDate = null, startAt = null, endAt = null;
  let startTzid = null, endTzid = null;

  for (const line of lines) {
    const upper = line.toUpperCase();
    if (upper === "BEGIN:VEVENT") { inVevent = true; continue; }
    if (upper === "END:VEVENT") { break; }
    if (!inVevent) continue;

    const { name, params, value } = parsePropFull(line);
    switch (name) {
      case "SUMMARY": if (!summary) summary = unescapeIcs(value); break;
      case "DESCRIPTION": if (!description) description = unescapeIcs(value); break;
      case "LOCATION": if (!location) location = unescapeIcs(value); break;
      case "UID": if (!uid) uid = value.trim(); break;
      case "CATEGORIES": labels = splitCategories(value).map((s) => s.trim().toLowerCase()); break;
      case "DTSTART": {
        const parsed = parseDtProp(value, params);
        if (parsed?.isAllDay) startDate = parsed.date;
        else if (parsed?.at != null) { startAt = parsed.at; startTzid = parsed.tzid || null; }
        break;
      }
      case "DTEND": {
        const parsed = parseDtProp(value, params);
        if (parsed?.isAllDay) endDate = parsed.date;
        else if (parsed?.at != null) { endAt = parsed.at; endTzid = parsed.tzid || null; }
        break;
      }
    }
  }

  return {
    uid,
    summary,
    description,
    location,
    labels,
    isAllDay: Boolean(startDate),
    startDate,
    endDate,
    startAt,
    endAt,
    startTzid,
    endTzid
  };
}

export function issueToVtodo(issue) {
  const labels = JSON.parse(issue.labels || "[]");
  const created = toUtcStamp(issue.created_at || issue.last_modified);
  const modified = toUtcStamp(issue.last_modified || issue.created_at);
  const isClosed = issue.status === "completed" || issue.status === "cancelled";
  const nevent = nip19.neventEncode({ id: issue.event_id, author: issue.pubkey });
  const url = `nostr:${nevent}`;

  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//nostr-caldav-bridge//EN",
    "CALSCALE:GREGORIAN",
    "BEGIN:VTODO",
    `UID:${escapeIcs(issue.caldav_uid)}`,
    `DTSTAMP:${modified}`,
    `CREATED:${created}`,
    `LAST-MODIFIED:${modified}`,
    `SEQUENCE:${issue.sequence || 0}`,
    `SUMMARY:${escapeIcs(issue.subject || "(no subject)")}`,
    `STATUS:${toVtodoFromInternal(issue.status)}`,
    `ORGANIZER;CN=${escapeIcs(issue.pubkey)}:mailto:noreply@nostr.local`,
    `URL:${escapeIcs(url)}`
  ];

  if (issue.due_date) {
    lines.push(`DUE;VALUE=DATE:${String(issue.due_date).replace(/-/g, "")}`);
  } else if (issue.due_at) {
    lines.push(`DUE:${toUtcStamp(issue.due_at)}`);
  }

  if (isClosed) {
    // Apple Reminders is more reliable when closed tasks include explicit completion markers.
    lines.push(`COMPLETED:${modified}`);
    lines.push("PERCENT-COMPLETE:100");
  }

  if (labels.length > 0) {
    lines.push(`CATEGORIES:${labels.map((l) => escapeIcs(l)).join(",")}`);
  }

  lines.push("END:VTODO", "END:VCALENDAR", "");
  return lines.join("\r\n");
}

function nostrEventToVeventComponent(event) {
  const tags = event.tags || [];
  const findTag = (name) => tags.find((t) => t[0] === name)?.[1] ?? null;
  const listTags = (name) => tags.filter((t) => t[0] === name).map((t) => t[1]).filter(Boolean);

  const title = findTag("title") ?? "(untitled)";
  const description = event.content ?? "";
  const location = findTag("location");
  const labelTags = listTags("t").map((v) => String(v).trim().toLowerCase()).filter(Boolean);
  const isAllDay = event.kind === CALENDAR_EVENT_DATE_KIND;

  const uid = `${event.id}@nostr-calendar`;
  const dtstamp = toUtcStamp(event.created_at);

  const startTag = findTag("start");
  const endTag = findTag("end");

  let dtstart = null;
  let dtend = null;

  if (startTag) {
    dtstart = isAllDay
      ? `DTSTART;VALUE=DATE:${String(startTag).replace(/-/g, "")}`
      : `DTSTART:${toUtcStamp(Number(startTag))}`;
  }
  if (endTag) {
    dtend = isAllDay
      ? `DTEND;VALUE=DATE:${String(endTag).replace(/-/g, "")}`
      : `DTEND:${toUtcStamp(Number(endTag))}`;
  }

  if (!dtstart) return null;

  let url = "";
  try {
    url = `nostr:${nip19.neventEncode({ id: event.id, author: event.pubkey })}`;
  } catch {
    url = `nostr:${event.id}`;
  }

  const lines = [
    "BEGIN:VEVENT",
    `UID:${escapeIcs(uid)}`,
    `DTSTAMP:${dtstamp}`,
    `CREATED:${dtstamp}`,
    `LAST-MODIFIED:${dtstamp}`,
    "SEQUENCE:0",
    `SUMMARY:${escapeIcs(title)}`,
    description ? `DESCRIPTION:${escapeIcs(description)}` : null,
    dtstart,
    dtend,
    location ? `LOCATION:${escapeIcs(location)}` : null,
    `ORGANIZER;CN=${escapeIcs(event.pubkey)}:mailto:noreply@nostr.local`,
    `URL:${escapeIcs(url)}`
  ];

  if (labelTags.length > 0) {
    lines.push(`CATEGORIES:${labelTags.map((l) => escapeIcs(l)).join(",")}`);
  }

  lines.push("END:VEVENT");
  return lines.filter(Boolean).join("\r\n");
}

export function nostrCalendarEventsToIcsFeed(nostrEvents, { calendarName = "Nostr Calendar" } = {}) {
  const components = (nostrEvents || []).map((ev) => nostrEventToVeventComponent(ev)).filter(Boolean);
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//nostr-caldav-bridge//EN",
    "CALSCALE:GREGORIAN",
    `X-WR-CALNAME:${escapeIcs(calendarName)}`,
    ...components,
    "END:VCALENDAR",
    ""
  ].join("\r\n");
}

export function calendarEventToVevent(calEvent) {
  const labels = JSON.parse(calEvent.labels || "[]");
  const created = toUtcStamp(calEvent.created_at || calEvent.last_modified);
  const modified = toUtcStamp(calEvent.last_modified || calEvent.created_at);
  const nevent = nip19.neventEncode({ id: calEvent.event_id, author: calEvent.pubkey });
  const url = `nostr:${nevent}`;

  let dtstart, dtend;
  if (calEvent.is_all_day) {
    const startPacked = String(calEvent.start_date || "").replace(/-/g, "");
    const endPacked = String(calEvent.end_date || "").replace(/-/g, "");
    dtstart = startPacked ? `DTSTART;VALUE=DATE:${startPacked}` : null;
    dtend = endPacked ? `DTEND;VALUE=DATE:${endPacked}` : null;
  } else {
    const sTzid = calEvent.start_tzid || null;
    const eTzid = calEvent.end_tzid || calEvent.start_tzid || null;
    try {
      dtstart = calEvent.start_at
        ? (sTzid ? `DTSTART;TZID=${sTzid}:${toLocalStamp(calEvent.start_at, sTzid)}` : `DTSTART:${toUtcStamp(calEvent.start_at)}`)
        : null;
      dtend = calEvent.end_at
        ? (eTzid ? `DTEND;TZID=${eTzid}:${toLocalStamp(calEvent.end_at, eTzid)}` : `DTEND:${toUtcStamp(calEvent.end_at)}`)
        : null;
    } catch {
      dtstart = calEvent.start_at ? `DTSTART:${toUtcStamp(calEvent.start_at)}` : null;
      dtend = calEvent.end_at ? `DTEND:${toUtcStamp(calEvent.end_at)}` : null;
    }
  }

  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//nostr-caldav-bridge//EN",
    "CALSCALE:GREGORIAN",
    "BEGIN:VEVENT",
    `UID:${escapeIcs(calEvent.caldav_uid)}`,
    `DTSTAMP:${modified}`,
    `CREATED:${created}`,
    `LAST-MODIFIED:${modified}`,
    `SEQUENCE:${calEvent.sequence || 0}`,
    `SUMMARY:${escapeIcs(calEvent.title || "(untitled)")}`,
    `DESCRIPTION:${escapeIcs(calEvent.description || "")}`,
    dtstart,
    dtend,
    calEvent.location ? `LOCATION:${escapeIcs(calEvent.location)}` : null,
    `ORGANIZER;CN=${escapeIcs(calEvent.pubkey)}:mailto:noreply@nostr.local`,
    `URL:${escapeIcs(url)}`
  ];

  if (labels.length > 0) {
    lines.push(`CATEGORIES:${labels.map((l) => escapeIcs(l)).join(",")}`);
  }

  lines.push("END:VEVENT", "END:VCALENDAR", "");
  return lines.filter(Boolean).join("\r\n");
}
