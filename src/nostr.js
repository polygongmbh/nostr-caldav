import { SimplePool } from "nostr-tools";

export class NostrSubscriber {
  constructor({ relays, authors, since, onIssue }) {
    this.pool = new SimplePool();
    this.relays = relays;
    this.authors = authors;
    this.since = since;
    this.onIssue = onIssue;
    this.seen = new Set();
  }

  start() {
    const filters = [
      {
        kinds: [1621],
        authors: this.authors,
        since: this.since
      }
    ];

    const sub = this.pool.subscribeMany(this.relays, filters, {
      onevent: (event) => {
        if (this.seen.has(event.id)) return;
        this.seen.add(event.id);
        this.onIssue(event);
      },
      oneose: () => {
        // Keep subscription open for real-time updates.
      },
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
