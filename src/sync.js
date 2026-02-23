export function createSyncService({ db, publisher }) {
  return {
    onIssueEvent(event, relayUrl) {
      db.upsertIssueFromNostr(event, relayUrl);
    },

    onStatusEvent(statusEvent) {
      db.applyStatusEventFromNostr(statusEvent);
    },

    onCommentEvent(commentEvent) {
      db.applyCommentEventFromNostr(commentEvent);
    },

    async publishStatusFromCaldav(issueEventId, status) {
      const published = await publisher.publishStatusChange({ issueEventId, status });
      if (published.skipped) {
        db.logSync({
          direction: "caldav_to_nostr",
          eventId: issueEventId,
          action: "publish_skipped",
          error: published.reason
        });
        return published;
      }

      db.logSync({
        direction: "caldav_to_nostr",
        eventId: issueEventId,
        action: `published_kind_${published.event.kind}`
      });

      return published;
    },

    close() {
      if (publisher?.close) publisher.close();
    }
  };
}
