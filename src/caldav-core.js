import { parseVtodo } from "./ics.js";

export function selectIssuesForSync({ currentToken, requestedToken, issues }) {
  if (requestedToken && requestedToken >= currentToken) {
    return [];
  }
  return issues;
}

export async function processVtodoPut({ db, syncService, uid, ifMatch, body }) {
  const issue = db.getIssueByUid(uid);
  if (!issue) {
    return { status: 404, error: "Not found" };
  }

  if (ifMatch && ifMatch !== issue.caldav_etag) {
    return { status: 412, error: "Precondition Failed" };
  }

  const parsed = parseVtodo(body || "");
  if (!parsed.internalStatus) {
    return { status: 400, error: "VTODO STATUS is required and must be supported" };
  }

  const update = db.updateStatusFromCaldav({ uid, internalStatus: parsed.internalStatus });

  if (update.changed) {
    try {
      await syncService.publishStatusFromCaldav(update.issue.event_id, update.issue.status);
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

  const refreshed = db.getIssueByUid(uid);
  return {
    status: 204,
    etag: refreshed.caldav_etag,
    changed: Boolean(update.changed)
  };
}
