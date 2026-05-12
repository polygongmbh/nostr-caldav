import { SimplePool, useWebSocketImplementation } from "nostr-tools/pool";
import WebSocket from "ws";
import { COMMENT_KIND, internalStatusToKind, ISSUE_KIND } from "./status.js";

function getEventRefId(tags) {
  return (tags || []).find((t) => t[0] === "e")?.[1] || null;
}

export class NostrSubscriber {
  constructor({ relays, authors, since, onIssue, onStatus, onComment, onauth }) {
    useWebSocketImplementation(WebSocket);
    this.pool = new SimplePool();
    this.relays = relays;
    this.authors = authors;
    this.since = since;
    this.onIssue = onIssue;
    this.onStatus = onStatus;
    this.onComment = onComment;
    this.onauth = onauth;
    this.seen = new Set();
  }

  start() {
    const issueFilter = {
      kinds: [ISSUE_KIND],
      since: this.since
    };

    if (Array.isArray(this.authors) && this.authors.length > 0) {
      issueFilter.authors = this.authors;
    }

    const eventHandler = (event) => {
      if (this.seen.has(event.id)) return;
      this.seen.add(event.id);

      if (event.kind === ISSUE_KIND) {
        this.onIssue(event);
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
      }
    };

    const commonParams = {
      onauth: this.onauth || undefined,
      onevent: eventHandler,
      oneose: () => {},
      onclose: (reasons) => {
        console.error("Nostr subscription closed", reasons);
      }
    };

    // subscribeMany accepts a single filter per subscription.
    const issueSub = this.pool.subscribeMany(this.relays, issueFilter, commonParams);
    this.subs = [
      issueSub,
      this.pool.subscribeMany(
        this.relays,
        {
          kinds: [1630, 1631, 1632, 1633],
          since: this.since
        },
        commonParams
      ),
      this.pool.subscribeMany(
        this.relays,
        {
          kinds: [COMMENT_KIND],
          since: this.since
        },
        commonParams
      )
    ];
    this.issueSubs = [issueSub];

    return this.subs;
  }

  addAuthor(pubkey) {
    const value = String(pubkey || "").trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(value)) return;
    if (Array.isArray(this.authors) && this.authors.includes(value)) return;

    if (!Array.isArray(this.authors)) {
      this.authors = [];
    }
    this.authors.push(value);

    const sub = this.pool.subscribeMany(
      this.relays,
      {
        kinds: [ISSUE_KIND],
        since: this.since,
        authors: [value]
      },
      {
        onauth: this.onauth || undefined,
        onevent: (event) => {
          if (this.seen.has(event.id)) return;
          this.seen.add(event.id);
          if (event.kind === ISSUE_KIND) {
            this.onIssue(event);
          }
        },
        oneose: () => {},
        onclose: () => {}
      }
    );
    if (!Array.isArray(this.issueSubs)) this.issueSubs = [];
    this.issueSubs.push(sub);
    if (!Array.isArray(this.subs)) this.subs = [];
    this.subs.push(sub);
  }

  stop() {
    if (Array.isArray(this.subs)) {
      this.subs.forEach((sub) => sub?.close());
    }
    this.pool.close(this.relays);
  }
}

export function createNostrPublisher({ relays, signer, onauth }) {
  useWebSocketImplementation(WebSocket);
  const pool = new SimplePool();

  return {
    enabled: Boolean(signer?.enabled),
    async publishIssueCreate({ summary, description, labels = [], signer: signerOverride = null }) {
      const activeSigner = signerOverride || signer;
      const activeOnauth = activeSigner ? async (eventTemplate) => activeSigner.signEvent(eventTemplate) : onauth || undefined;
      if (!activeSigner?.enabled) {
        return { skipped: true, reason: "missing_signer" };
      }

      const tags = [];
      if (summary) tags.push(["subject", summary]);
      
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

      await Promise.any(pool.publish(relays, signed, { onauth: activeOnauth }));
      return { skipped: false, event: signed };
    },
    async publishStatusChange({ issueEventId, status, signer: signerOverride = null }) {
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

      await Promise.any(pool.publish(relays, signed, { onauth: activeOnauth }));
      return { skipped: false, event: signed };
    },
    close() {
      pool.close(relays);
    }
  };
}
