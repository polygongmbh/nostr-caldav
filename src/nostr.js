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
    this.authorSigners = new Map();
  }

  makeEventHandler() {
    return (event) => {
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
  }

  buildOnauthForSigner(signerOverride) {
    if (signerOverride?.enabled) {
      return async (eventTemplate) => signerOverride.signEvent(eventTemplate);
    }
    return this.onauth || undefined;
  }

  subscribeAuthor(pubkey, signerOverride = null) {
    const onauth = this.buildOnauthForSigner(signerOverride);
    const eventHandler = this.makeEventHandler();

    const makeParams = () => ({
      onauth,
      onevent: eventHandler,
      oneose: () => {},
      onclose: (reasons) => {
        console.error("Nostr subscription closed", reasons);
      }
    });

    const subscriptions = [
      this.pool.subscribeMany(
        this.relays,
        { kinds: [ISSUE_KIND], since: this.since, authors: [pubkey] },
        makeParams()
      ),
      this.pool.subscribeMany(
        this.relays,
        {
          kinds: [1630, 1631, 1632, 1633],
          since: this.since,
          authors: [pubkey]
        },
        makeParams()
      ),
      this.pool.subscribeMany(
        this.relays,
        {
          kinds: [COMMENT_KIND],
          since: this.since,
          authors: [pubkey]
        },
        makeParams()
      )
    ];
    return subscriptions;
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

    const eventHandler = this.makeEventHandler();

    for (const chunk of chunks) {
      await new Promise((resolve) => {
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          sub?.close?.();
          resolve();
        };

        const timer = setTimeout(finish, timeoutMs);
        const sub = this.pool.subscribeMany(
          this.relays,
          { kinds: [ISSUE_KIND], ids: chunk },
          {
            onevent: eventHandler,
            oneose: finish,
            onclose: finish
          }
        );
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

    const eventHandler = this.makeEventHandler();

    for (const chunk of chunks) {
      await new Promise((resolve) => {
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          sub?.close?.();
          resolve();
        };

        const timer = setTimeout(finish, timeoutMs);
        const sub = this.pool.subscribeMany(
          this.relays,
          { kinds: [ISSUE_KIND], "#e": chunk },
          {
            onevent: eventHandler,
            oneose: finish,
            onclose: finish
          }
        );
      });
    }

    return { requested: ids.length, chunks: chunks.length };
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

    const eventHandler = this.makeEventHandler();

    for (const chunk of chunks) {
      await new Promise((resolve) => {
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          sub?.close?.();
          resolve();
        };

        const timer = setTimeout(finish, timeoutMs);
        const filter = { kinds: [ISSUE_KIND], authors: chunk };
        if (typeof since === "number") filter.since = since;
        const sub = this.pool.subscribeMany(this.relays, filter, {
          onevent: eventHandler,
          oneose: finish,
          onclose: finish
        });
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

    const eventHandler = this.makeEventHandler();

    for (const chunk of chunks) {
      await new Promise((resolve) => {
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          sub?.close?.();
          resolve();
        };

        const timer = setTimeout(finish, timeoutMs);
        const filter = { kinds: [ISSUE_KIND], "#p": chunk };
        if (typeof since === "number") filter.since = since;
        const sub = this.pool.subscribeMany(this.relays, filter, {
          onevent: eventHandler,
          oneose: finish,
          onclose: finish
        });
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

    const eventHandler = this.makeEventHandler();

    for (const chunk of chunks) {
      await new Promise((resolve) => {
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          sub?.close?.();
          resolve();
        };

        const timer = setTimeout(finish, timeoutMs);
        const filter = { kinds: [1630, 1631, 1632, 1633], "#e": chunk };
        if (typeof since === "number") filter.since = since;
        const sub = this.pool.subscribeMany(this.relays, filter, {
          onevent: eventHandler,
          oneose: finish,
          onclose: finish
        });
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
    async publishIssueCreate({ summary, description, channelTag = null, labels = [], signer: signerOverride = null }) {
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
