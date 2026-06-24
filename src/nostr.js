import { SimplePool, useWebSocketImplementation } from "nostr-tools/pool";
import WebSocket from "ws";
import { CALENDAR_EVENT_DATE_KIND, CALENDAR_EVENT_TIME_KIND, COMMENT_KIND, internalStatusToKind, ISSUE_KIND } from "./status.js";

function getEventRefId(tags) {
  return (tags || []).find((t) => t[0] === "e")?.[1] || null;
}

export class NostrSubscriber {
  constructor({ relays, authors, since, onIssue, onStatus, onComment, onCalendarEvent, onauth }) {
    useWebSocketImplementation(WebSocket);
    this.pool = new SimplePool();
    this.relays = relays;
    this.authors = authors;
    this.since = since;
    this.onIssue = onIssue;
    this.onStatus = onStatus;
    this.onComment = onComment;
    this.onCalendarEvent = onCalendarEvent;
    this.onauth = onauth;
    // Tracks "eventId:relayUrl" to allow the same event from different relays
    // to be processed separately for relay attribution.
    this.seen = new Set();
    this.authorSigners = new Map();
    // Tracks "pubkey:relayUrl" pairs that already have active subscriptions.
    this.subscribedAuthorRelays = new Set();
  }

  makeRelayEventHandler(relayUrl) {
    return (event) => {
      const key = `${event.id}:${relayUrl || ""}`;
      if (this.seen.has(key)) return;
      this.seen.add(key);

      if (event.kind === ISSUE_KIND) {
        this.onIssue(event, relayUrl);
        return;
      }

      if (event.kind >= 1630 && event.kind <= 1633) {
        const issueId = getEventRefId(event.tags);
        this.onStatus(event, issueId);
        return;
      }

      if (event.kind === COMMENT_KIND) {
        const issueId = getEventRefId(event.tags);
        this.onComment(event, issueId);
        return;
      }

      if (event.kind === CALENDAR_EVENT_DATE_KIND || event.kind === CALENDAR_EVENT_TIME_KIND) {
        if (this.onCalendarEvent) this.onCalendarEvent(event, relayUrl);
      }
    };
  }

  buildOnauthForSigner(signerOverride) {
    if (signerOverride?.enabled) {
      return async (eventTemplate) => signerOverride.signEvent(eventTemplate);
    }
    return this.onauth || undefined;
  }

  subscribeAuthor(pubkey, signerOverride = null) {
    const onauth = this.buildOnauthForSigner(signerOverride);
    const subscriptions = [];

    for (const relay of this.relays) {
      this.subscribedAuthorRelays.add(`${pubkey}:${relay}`);
      const eventHandler = this.makeRelayEventHandler(relay);

      const makeParams = () => ({
        onauth,
        onevent: eventHandler,
        oneose: () => {},
        onclose: (reasons) => {
          console.error("Nostr subscription closed", reasons);
        }
      });

      subscriptions.push(
        this.pool.subscribeMany([relay], { kinds: [ISSUE_KIND], since: this.since, authors: [pubkey] }, makeParams()),
        this.pool.subscribeMany([relay], { kinds: [1630, 1631, 1632, 1633], since: this.since, authors: [pubkey] }, makeParams()),
        this.pool.subscribeMany([relay], { kinds: [COMMENT_KIND], since: this.since, authors: [pubkey] }, makeParams()),
        this.pool.subscribeMany(
          [relay],
          { kinds: [CALENDAR_EVENT_DATE_KIND, CALENDAR_EVENT_TIME_KIND], since: this.since, authors: [pubkey] },
          makeParams()
        )
      );
    }

    return subscriptions;
  }

  // Runs a one-shot subscription across all relays in parallel, attributing events to their relay.
  async _fetchPerRelay(filters, timeoutMs, onevent) {
    const filterArr = Array.isArray(filters) ? filters : [filters];
    await Promise.all(
      this.relays.map(
        (relay) =>
          new Promise((resolve) => {
            let done = false;
            const finish = () => {
              if (done) return;
              done = true;
              clearTimeout(timer);
              sub?.close?.();
              resolve();
            };
            const timer = setTimeout(finish, timeoutMs);
            const sub = this.pool.subscribeMany([relay], filterArr, {
              onevent: (event) => onevent(event, relay),
              oneose: finish,
              onclose: finish
            });
          })
      )
    );
  }

  start() {
    this.subs = [];
    if (Array.isArray(this.authors)) {
      for (const author of this.authors) {
        const normalized = String(author || "").trim().toLowerCase();
        if (!/^[0-9a-f]{64}$/.test(normalized)) continue;
        const signer = this.authorSigners.get(normalized) || null;
        const authorSubs = this.subscribeAuthor(normalized, signer);
        this.subs.push(...authorSubs);
      }
    }

    return this.subs;
  }

  // Subscribe a single author to a relay that isn't in this.relays yet.
  // Used when a user authenticates with a relay-scoped CalDAV credential.
  subscribeAuthorToRelay(pubkey, relayUrl) {
    const value = String(pubkey || "").trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(value)) return;
    const key = `${value}:${relayUrl}`;
    if (this.subscribedAuthorRelays.has(key)) return;
    this.subscribedAuthorRelays.add(key);
    const signer = this.authorSigners.get(value) || null;
    const onauth = this.buildOnauthForSigner(signer);
    const eventHandler = this.makeRelayEventHandler(relayUrl);

    const makeParams = () => ({
      onauth,
      onevent: eventHandler,
      oneose: () => {},
      onclose: (reasons) => {
        console.error("Nostr subscription closed", reasons);
      }
    });

    const newSubs = [
      this.pool.subscribeMany([relayUrl], { kinds: [ISSUE_KIND], since: this.since, authors: [value] }, makeParams()),
      this.pool.subscribeMany([relayUrl], { kinds: [1630, 1631, 1632, 1633], since: this.since, authors: [value] }, makeParams()),
      this.pool.subscribeMany([relayUrl], { kinds: [COMMENT_KIND], since: this.since, authors: [value] }, makeParams()),
      this.pool.subscribeMany(
        [relayUrl],
        { kinds: [CALENDAR_EVENT_DATE_KIND, CALENDAR_EVENT_TIME_KIND], since: this.since, authors: [value] },
        makeParams()
      )
    ];

    if (!Array.isArray(this.subs)) this.subs = [];
    this.subs.push(...newSubs);
  }

  // Fetch all task-related events for a single author from a single relay.
  // Used for targeted catch-up when a user authenticates with a relay-scoped credential.
  async catchupAuthorOnRelay(pubkey, relayUrl, since, timeoutMs = 15000) {
    const value = String(pubkey || "").trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(value)) return;
    const handler = this.makeRelayEventHandler(relayUrl);

    const filters = [
      { kinds: [ISSUE_KIND], authors: [value], since },
      { kinds: [1630, 1631, 1632, 1633], authors: [value], since },
      { kinds: [COMMENT_KIND], authors: [value], since },
      { kinds: [CALENDAR_EVENT_DATE_KIND, CALENDAR_EVENT_TIME_KIND], authors: [value], since }
    ];

    await Promise.all(
      filters.map(
        (filter) =>
          new Promise((resolve) => {
            let done = false;
            const finish = () => {
              if (done) return;
              done = true;
              clearTimeout(timer);
              sub?.close?.();
              resolve();
            };
            const timer = setTimeout(finish, timeoutMs);
            const sub = this.pool.subscribeMany([relayUrl], [filter], {
              onevent: handler,
              oneose: finish,
              onclose: finish
            });
          })
      )
    );
  }

  addAuthor(pubkey, signerOverride = null) {
    const value = String(pubkey || "").trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(value)) return;
    const alreadyTracked = Array.isArray(this.authors) && this.authors.includes(value);
    if (alreadyTracked) {
      if (signerOverride?.enabled) {
        this.authorSigners.set(value, signerOverride);
      }
      return;
    }

    if (!Array.isArray(this.authors)) {
      this.authors = [];
    }
    this.authors.push(value);
    if (signerOverride?.enabled) {
      this.authorSigners.set(value, signerOverride);
    }

    const addedSubs = this.subscribeAuthor(value, signerOverride);
    if (!Array.isArray(this.subs)) this.subs = [];
    this.subs.push(...addedSubs);
  }

  stop() {
    if (Array.isArray(this.subs)) {
      this.subs.forEach((sub) => sub?.close());
    }
    this.pool.close(this.relays);
  }

  async refetchIssuesByIds(eventIds = [], options = {}) {
    const ids = Array.from(
      new Set(
        (eventIds || [])
          .map((value) => String(value || "").trim().toLowerCase())
          .filter((value) => /^[0-9a-f]{64}$/.test(value))
      )
    );
    if (ids.length === 0) return { requested: 0, chunks: 0 };

    const chunkSize = Math.max(1, Math.min(Number(options.chunkSize) || 200, 500));
    const timeoutMs = Math.max(1000, Math.min(Number(options.timeoutMs) || 10000, 60000));
    const chunks = [];
    for (let i = 0; i < ids.length; i += chunkSize) {
      chunks.push(ids.slice(i, i + chunkSize));
    }

    for (const chunk of chunks) {
      await this._fetchPerRelay({ kinds: [ISSUE_KIND], ids: chunk }, timeoutMs, (event, relayUrl) => {
        const key = `${event.id}:${relayUrl || ""}`;
        if (this.seen.has(key)) return;
        this.seen.add(key);
        if (event.kind === ISSUE_KIND) this.onIssue(event, relayUrl);
      });
    }

    return { requested: ids.length, chunks: chunks.length };
  }

  async refetchIssuesByParentIds(parentIds = [], options = {}) {
    const ids = Array.from(
      new Set(
        (parentIds || [])
          .map((value) => String(value || "").trim().toLowerCase())
          .filter((value) => /^[0-9a-f]{64}$/.test(value))
      )
    );
    if (ids.length === 0) return { requested: 0, chunks: 0 };

    const chunkSize = Math.max(1, Math.min(Number(options.chunkSize) || 200, 500));
    const timeoutMs = Math.max(1000, Math.min(Number(options.timeoutMs) || 10000, 60000));
    const chunks = [];
    for (let i = 0; i < ids.length; i += chunkSize) {
      chunks.push(ids.slice(i, i + chunkSize));
    }

    for (const chunk of chunks) {
      await this._fetchPerRelay({ kinds: [ISSUE_KIND], "#e": chunk }, timeoutMs, (event, relayUrl) => {
        const key = `${event.id}:${relayUrl || ""}`;
        if (this.seen.has(key)) return;
        this.seen.add(key);
        if (event.kind === ISSUE_KIND) this.onIssue(event, relayUrl);
      });
    }

    return { requested: ids.length, chunks: chunks.length };
  }

  async refetchCalendarEventsByAuthors(pubkeys = [], options = {}) {
    const authors = Array.from(
      new Set(
        (pubkeys || [])
          .map((value) => String(value || "").trim().toLowerCase())
          .filter((value) => /^[0-9a-f]{64}$/.test(value))
      )
    );
    if (authors.length === 0) return { requested: 0, chunks: 0 };

    const chunkSize = Math.max(1, Math.min(Number(options.chunkSize) || 50, 200));
    const timeoutMs = Math.max(1000, Math.min(Number(options.timeoutMs) || 10000, 60000));
    const since = Number.isFinite(Number(options.since)) ? Number(options.since) : undefined;
    const chunks = [];
    for (let i = 0; i < authors.length; i += chunkSize) {
      chunks.push(authors.slice(i, i + chunkSize));
    }

    for (const chunk of chunks) {
      const filter = { kinds: [CALENDAR_EVENT_DATE_KIND, CALENDAR_EVENT_TIME_KIND], authors: chunk };
      if (typeof since === "number") filter.since = since;
      await this._fetchPerRelay(filter, timeoutMs, (event, relayUrl) => {
        const key = `${event.id}:${relayUrl || ""}`;
        if (this.seen.has(key)) return;
        this.seen.add(key);
        if (this.onCalendarEvent) this.onCalendarEvent(event, relayUrl);
      });
    }

    return { requested: authors.length, chunks: chunks.length };
  }

  async refetchIssuesByAuthors(pubkeys = [], options = {}) {
    const authors = Array.from(
      new Set(
        (pubkeys || [])
          .map((value) => String(value || "").trim().toLowerCase())
          .filter((value) => /^[0-9a-f]{64}$/.test(value))
      )
    );
    if (authors.length === 0) return { requested: 0, chunks: 0 };

    const chunkSize = Math.max(1, Math.min(Number(options.chunkSize) || 50, 200));
    const timeoutMs = Math.max(1000, Math.min(Number(options.timeoutMs) || 10000, 60000));
    const since = Number.isFinite(Number(options.since)) ? Number(options.since) : undefined;
    const chunks = [];
    for (let i = 0; i < authors.length; i += chunkSize) {
      chunks.push(authors.slice(i, i + chunkSize));
    }

    for (const chunk of chunks) {
      const filter = { kinds: [ISSUE_KIND], authors: chunk };
      if (typeof since === "number") filter.since = since;
      await this._fetchPerRelay(filter, timeoutMs, (event, relayUrl) => {
        const key = `${event.id}:${relayUrl || ""}`;
        if (this.seen.has(key)) return;
        this.seen.add(key);
        if (event.kind === ISSUE_KIND) this.onIssue(event, relayUrl);
      });
    }

    return { requested: authors.length, chunks: chunks.length };
  }

  async refetchIssuesByMentionPubkeys(pubkeys = [], options = {}) {
    const mentions = Array.from(
      new Set(
        (pubkeys || [])
          .map((value) => String(value || "").trim().toLowerCase())
          .filter((value) => /^[0-9a-f]{64}$/.test(value))
      )
    );
    if (mentions.length === 0) return { requested: 0, chunks: 0 };

    const chunkSize = Math.max(1, Math.min(Number(options.chunkSize) || 50, 200));
    const timeoutMs = Math.max(1000, Math.min(Number(options.timeoutMs) || 10000, 60000));
    const since = Number.isFinite(Number(options.since)) ? Number(options.since) : undefined;
    const chunks = [];
    for (let i = 0; i < mentions.length; i += chunkSize) {
      chunks.push(mentions.slice(i, i + chunkSize));
    }

    for (const chunk of chunks) {
      const filter = { kinds: [ISSUE_KIND], "#p": chunk };
      if (typeof since === "number") filter.since = since;
      await this._fetchPerRelay(filter, timeoutMs, (event, relayUrl) => {
        const key = `${event.id}:${relayUrl || ""}`;
        if (this.seen.has(key)) return;
        this.seen.add(key);
        if (event.kind === ISSUE_KIND) this.onIssue(event, relayUrl);
      });
    }

    return { requested: mentions.length, chunks: chunks.length };
  }

  async refetchStatusEventsByIssueIds(eventIds = [], options = {}) {
    const ids = Array.from(
      new Set(
        (eventIds || [])
          .map((value) => String(value || "").trim().toLowerCase())
          .filter((value) => /^[0-9a-f]{64}$/.test(value))
      )
    );
    if (ids.length === 0) return { requested: 0, chunks: 0 };

    const chunkSize = Math.max(1, Math.min(Number(options.chunkSize) || 200, 500));
    const timeoutMs = Math.max(1000, Math.min(Number(options.timeoutMs) || 10000, 60000));
    const since = Number.isFinite(Number(options.since)) ? Number(options.since) : undefined;
    const chunks = [];
    for (let i = 0; i < ids.length; i += chunkSize) {
      chunks.push(ids.slice(i, i + chunkSize));
    }

    for (const chunk of chunks) {
      const filter = { kinds: [1630, 1631, 1632, 1633], "#e": chunk };
      if (typeof since === "number") filter.since = since;
      await this._fetchPerRelay(filter, timeoutMs, (event, relayUrl) => {
        const key = `${event.id}:${relayUrl || ""}`;
        if (this.seen.has(key)) return;
        this.seen.add(key);
        const issueId = getEventRefId(event.tags);
        this.onStatus(event, issueId);
      });
    }

    return { requested: ids.length, chunks: chunks.length };
  }
}

export function createNostrPublisher({ relays, signer, onauth }) {
  useWebSocketImplementation(WebSocket);
  const pool = new SimplePool();

  return {
    enabled: Boolean(signer?.enabled),
    async publishIssueCreate({ summary, description, channelTag = null, labels = [], signer: signerOverride = null, publishRelays = null }) {
      const activeSigner = signerOverride || signer;
      const activeOnauth = activeSigner ? async (eventTemplate) => activeSigner.signEvent(eventTemplate) : onauth || undefined;
      if (!activeSigner?.enabled) {
        return { skipped: true, reason: "missing_signer" };
      }

      const tags = [];
      if (summary) tags.push(["subject", summary]);
      if (channelTag) tags.push(["t", String(channelTag).trim().toLowerCase()]);

      // Extract hashtags from summary for nodex feed compatibility
      const hashtags = (summary || "").match(/#\w+/g) || [];
      for (const hashtag of hashtags) {
        tags.push(["t", hashtag.slice(1)]); // Remove # prefix for t-tag
      }

      for (const label of labels) {
        const value = String(label || "").trim();
        if (value) tags.push(["label", value]);
      }

      const signed = await activeSigner.signEvent({
        kind: ISSUE_KIND,
        created_at: Math.floor(Date.now() / 1000),
        tags,
        content: String(description || summary || "")
      });

      const targetRelays = (Array.isArray(publishRelays) && publishRelays.length > 0) ? publishRelays : relays;
      await Promise.any(pool.publish(targetRelays, signed, { onauth: activeOnauth }));
      return { skipped: false, event: signed };
    },
    async publishStatusChange({ issueEventId, status, signer: signerOverride = null, publishRelays = null }) {
      const activeSigner = signerOverride || signer;
      const activeOnauth = activeSigner ? async (eventTemplate) => activeSigner.signEvent(eventTemplate) : onauth || undefined;
      if (!activeSigner?.enabled) {
        return { skipped: true, reason: "missing_signer" };
      }

      const kind = internalStatusToKind(status);
      if (!kind) {
        throw new Error(`Unsupported status for Nostr publish: ${status}`);
      }

      const signed = await activeSigner.signEvent({
        kind,
        created_at: Math.floor(Date.now() / 1000),
        tags: [["e", issueEventId]],
        content: ""
      });

      const targetRelays = (Array.isArray(publishRelays) && publishRelays.length > 0) ? publishRelays : relays;
      await Promise.any(pool.publish(targetRelays, signed, { onauth: activeOnauth }));
      return { skipped: false, event: signed };
    },
    async publishCalendarEventCreate({ uid, summary, description, location, labels, isAllDay, startDate, endDate, startAt, endAt, tagNames, taskRef = null, signer: signerOverride = null, publishRelays = null }) {
      const activeSigner = signerOverride || signer;
      const activeOnauth = activeSigner ? async (eventTemplate) => activeSigner.signEvent(eventTemplate) : onauth || undefined;
      if (!activeSigner?.enabled) {
        return { skipped: true, reason: "missing_signer" };
      }

      const kind = isAllDay ? CALENDAR_EVENT_DATE_KIND : CALENDAR_EVENT_TIME_KIND;
      const tags = [
        ["d", String(uid || "")],
        ["title", String(summary || "")]
      ];

      if (isAllDay) {
        if (startDate) tags.push(["start", startDate]);
        if (endDate) tags.push(["end", endDate]);
      } else {
        if (startAt != null) tags.push(["start", String(startAt)]);
        if (endAt != null) tags.push(["end", String(endAt)]);
      }

      if (location) tags.push(["location", location]);

      if (taskRef) {
        tags.push(["e", String(taskRef), "", "task"]);
        tags.push(["date_type", "due"]);
      }

      // Merge calendar-derived tags and event labels, deduped
      const allTags = new Set([...(tagNames || []), ...(labels || [])].map((t) => String(t || "").trim().toLowerCase()).filter(Boolean));
      for (const tag of allTags) tags.push(["t", tag]);

      const signed = await activeSigner.signEvent({
        kind,
        created_at: Math.floor(Date.now() / 1000),
        tags,
        content: String(description || summary || "")
      });

      const targetRelays = (Array.isArray(publishRelays) && publishRelays.length > 0) ? publishRelays : relays;
      await Promise.any(pool.publish(targetRelays, signed, { onauth: activeOnauth }));
      return { skipped: false, event: signed };
    },
    close() {
      pool.close(relays);
    }
  };
}
