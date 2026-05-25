import { nip19 } from "nostr-tools";
import { toInternalFromVtodo, toVtodoFromInternal } from "./status.js";

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
      (props["PERCENT-COMPLETE"] === "100" ? "completed" : null)
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
    `DESCRIPTION:${escapeIcs(issue.body || "")}`,
    `STATUS:${toVtodoFromInternal(issue.status)}`,
    `ORGANIZER;CN=${escapeIcs(issue.pubkey)}:mailto:noreply@nostr.local`,
    `URL:${escapeIcs(url)}`
  ];

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
