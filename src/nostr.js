import { SimplePool, finalizeEvent, getPublicKey, nip19 } from "nostr-tools";
import { COMMENT_KIND, internalStatusToKind, ISSUE_KIND } from "./status.js";

function decodePrivateKey(privateKey) {
  if (!privateKey) return null;

  if (privateKey.startsWith("nsec1")) {
    const decoded = nip19.decode(privateKey);
    if (decoded.type !== "nsec") {
      throw new Error(`Expected nsec private key, got ${decoded.type}`);
    }
    return decoded.data;
  }

  if (/^[0-9a-fA-F]{64}$/.test(privateKey)) {
    return Uint8Array.from(Buffer.from(privateKey, "hex"));
  }

  throw new Error("Unsupported private key format. Use nsec1... or 64-byte hex.");
}

function getEventRefId(tags) {
  return (tags || []).find((t) => t[0] === "e")?.[1] || null;
}

export class NostrSubscriber {
  constructor({ relays, authors, since, onIssue, onStatus, onComment }) {
    this.pool = new SimplePool();
    this.relays = relays;
    this.authors = authors;
    this.since = since;
    this.onIssue = onIssue;
    this.onStatus = onStatus;
    this.onComment = onComment;
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

    const filters = [
      issueFilter,
      {
        kinds: [1630, 1631, 1632, 1633],
        since: this.since
      },
      {
        kinds: [COMMENT_KIND],
        since: this.since
      }
    ];

    const sub = this.pool.subscribeMany(this.relays, filters, {
      onevent: (event) => {
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
      },
      oneose: () => {},
      onclose: (reasons) => {
        console.error("Nostr subscription closed", reasons);
      }
    });

    this.sub = sub;
    return sub;
  }

  stop() {
    if (this.sub) {
      this.sub.close();
    }
    this.pool.close(this.relays);
  }
}

export function createNostrPublisher({ relays, privateKey }) {
  const privateKeyBytes = decodePrivateKey(privateKey);

  if (!privateKeyBytes) {
    return {
      enabled: false,
      async publishStatusChange() {
        return { skipped: true, reason: "missing_private_key" };
      }
    };
  }

  const pool = new SimplePool();
  const pubkey = getPublicKey(privateKeyBytes);

  return {
    enabled: true,
    async publishStatusChange({ issueEventId, status }) {
      const kind = internalStatusToKind(status);
      if (!kind) {
        throw new Error(`Unsupported status for Nostr publish: ${status}`);
      }

      const eventTemplate = {
        kind,
        created_at: Math.floor(Date.now() / 1000),
        tags: [["e", issueEventId]],
        content: ""
      };

      const signed = finalizeEvent(eventTemplate, privateKeyBytes);
      if (signed.pubkey !== pubkey) {
        throw new Error("Signed event pubkey mismatch");
      }

      await Promise.any(pool.publish(relays, signed));
      return { skipped: false, event: signed };
    },
    close() {
      pool.close(relays);
    }
  };
}
