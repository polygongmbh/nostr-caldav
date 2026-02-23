import { nip19 } from "nostr-tools";

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

function statusToVtodo(status) {
  switch (status) {
    case "closed":
      return "COMPLETED";
    case "draft":
      return "IN-PROCESS";
    case "cancelled":
      return "CANCELLED";
    case "open":
    default:
      return "NEEDS-ACTION";
  }
}

export function issueToVtodo(issue) {
  const labels = JSON.parse(issue.labels || "[]");
  const created = toUtcStamp(issue.created_at || issue.last_modified);
  const modified = toUtcStamp(issue.last_modified || issue.created_at);
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
    `STATUS:${statusToVtodo(issue.status)}`,
    `ORGANIZER;CN=${escapeIcs(issue.pubkey)}:mailto:noreply@nostr.local`,
    `URL:${escapeIcs(url)}`
  ];

  if (labels.length > 0) {
    lines.push(`CATEGORIES:${labels.map((l) => escapeIcs(l)).join(",")}`);
  }

  lines.push("END:VTODO", "END:VCALENDAR", "");
  return lines.join("\r\n");
}
