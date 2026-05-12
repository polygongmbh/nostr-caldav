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

    async publishStatusFromCaldav(issueEventId, status, options = {}) {
      const published = await publisher.publishStatusChange({ issueEventId, status, signer: options.authContext?.signer || null });
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

    async createIssueFromCaldav({ uid, summary, description, labels = [], status = "open" }, options = {}) {
      const publishedIssue = await publisher.publishIssueCreate({
        summary,
        description,
        labels,
        signer: options.authContext?.signer || null
      });
      if (publishedIssue.skipped) {
        db.logSync({
          direction: "caldav_to_nostr",
          eventId: uid,
          action: "create_issue_skipped",
          error: publishedIssue.reason
        });
        return publishedIssue;
      }

      db.upsertIssueFromNostr(publishedIssue.event, "caldav-bridge");
      db.setIssueUidFromCaldav({ eventId: publishedIssue.event.id, uid });

      db.logSync({
        direction: "caldav_to_nostr",
        eventId: publishedIssue.event.id,
        action: "published_kind_1621"
      });

      if (status && status !== "open") {
        await this.publishStatusFromCaldav(publishedIssue.event.id, status, options);
      }

      return {
        skipped: false,
        event: publishedIssue.event,
        issue: db.getIssueByEventId(publishedIssue.event.id)
      };
    },

    close() {
      if (publisher?.close) publisher.close();
    }
  };
}
