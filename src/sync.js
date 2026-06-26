function getPublishRelays(authContext) {
  const filter = authContext?.noas?.relayFilter || authContext?.principal?.relayFilter || null;
  return filter ? [filter] : null;
}

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

    onCalendarEvent(event, relayUrl) {
      db.upsertCalendarEventFromNostr(event, relayUrl);
    },

    async publishStatusFromCaldav(issueEventId, status, options = {}) {
      const published = await publisher.publishStatusChange({ issueEventId, status, signer: options.authContext?.signer || null, publishRelays: getPublishRelays(options.authContext) });
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

    async createIssueFromCaldav({ uid, summary, description, labels = [], channelTag = null, status = "open", dueDate = null, dueAt = null }, options = {}) {
      const publishedIssue = await publisher.publishIssueCreate({
        summary,
        description,
        channelTag,
        labels,
        signer: options.authContext?.signer || null,
        publishRelays: getPublishRelays(options.authContext)
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

      if (dueDate || dueAt != null) {
        try {
          await this.updateDueDateFromCaldav(publishedIssue.event.id, { dueDate, dueAt }, options);
        } catch (error) {
          db.logSync({
            direction: "caldav_to_nostr",
            eventId: publishedIssue.event.id,
            action: "publish_due_date_failed",
            error: String(error)
          });
        }
      }

      return {
        skipped: false,
        event: publishedIssue.event,
        issue: db.getIssueByEventId(publishedIssue.event.id)
      };
    },

    async updateDueDateFromCaldav(issueEventId, { dueDate = null, dueAt = null }, options = {}) {
      // Update local DB immediately for CalDAV round-trip consistency.
      db.setIssueDueDate({ eventId: issueEventId, dueDate, dueAt });

      // Publish a task-linked NIP-52 calendar event so Nodex picks up the due date.
      // The d_tag pattern "task-date-{issueId}-due" is detected by upsertCalendarEventFromNostr.
      const isAllDay = Boolean(dueDate);
      const uid = `task-date-${issueEventId}-due`;
      const published = await publisher.publishCalendarEventCreate({
        uid,
        summary: "",
        description: "",
        location: null,
        labels: [],
        isAllDay,
        startDate: dueDate || null,
        endDate: null,
        startAt: dueAt ?? null,
        endAt: null,
        tagNames: [],
        taskRef: issueEventId,
        signer: options.authContext?.signer || null,
        publishRelays: getPublishRelays(options.authContext)
      });

      if (published.skipped) {
        db.logSync({
          direction: "caldav_to_nostr",
          eventId: issueEventId,
          action: "publish_due_date_skipped",
          error: published.reason
        });
        return published;
      }

      // Store the calendar event locally so the relay echo doesn't overwrite the due date
      // on the issue with stale values.
      db.upsertCalendarEventFromNostr(published.event, "caldav-bridge");

      db.logSync({
        direction: "caldav_to_nostr",
        eventId: issueEventId,
        action: `published_kind_${published.event.kind}`
      });

      return published;
    },

    async createCalendarEventFromCaldav({ uid, summary, description, location, labels, isAllDay, startDate, endDate, startAt, endAt, startTzid = null, endTzid = null, tagNames }, options = {}) {
      const published = await publisher.publishCalendarEventCreate({
        uid, summary, description, location, labels, isAllDay, startDate, endDate, startAt, endAt, startTzid, endTzid, tagNames,
        signer: options.authContext?.signer || null,
        publishRelays: getPublishRelays(options.authContext)
      });

      if (published.skipped) {
        db.logSync({
          direction: "caldav_to_nostr",
          eventId: uid,
          action: "create_calendar_event_skipped",
          error: published.reason
        });
        return published;
      }

      db.upsertCalendarEventFromNostr(published.event, "caldav-bridge");
      db.setCalendarEventUidFromCaldav({ eventId: published.event.id, uid });

      db.logSync({
        direction: "caldav_to_nostr",
        eventId: published.event.id,
        action: `published_kind_${published.event.kind}`
      });

      return {
        skipped: false,
        event: published.event,
        calEvent: db.getCalendarEventByUid(uid)
      };
    },

    async updateCalendarEventFromCaldav({ dTag, caldavUid, summary, description, location, labels, isAllDay, startDate, endDate, startAt, endAt, startTzid = null, endTzid = null, tagNames }, options = {}) {
      // dTag is the addressable d-tag of the existing event so the relay replaces it in-place.
      const published = await publisher.publishCalendarEventCreate({
        uid: dTag,
        summary, description, location, labels, isAllDay, startDate, endDate, startAt, endAt, startTzid, endTzid, tagNames,
        signer: options.authContext?.signer || null,
        publishRelays: getPublishRelays(options.authContext)
      });

      if (published.skipped) {
        db.logSync({
          direction: "caldav_to_nostr",
          eventId: caldavUid,
          action: "update_calendar_event_skipped",
          error: published.reason
        });
        return published;
      }

      db.upsertCalendarEventFromNostr(published.event, "caldav-bridge");

      db.logSync({
        direction: "caldav_to_nostr",
        eventId: published.event.id,
        action: `updated_kind_${published.event.kind}`
      });

      return {
        skipped: false,
        event: published.event,
        calEvent: db.getCalendarEventByUid(caldavUid)
      };
    },

    close() {
      if (publisher?.close) publisher.close();
    }
  };
}
