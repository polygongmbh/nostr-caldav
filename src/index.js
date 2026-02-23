import { loadConfig } from "./config.js";
import { openDb } from "./db.js";
import { NostrSubscriber, createNostrPublisher } from "./nostr.js";
import { createCaldavServer } from "./caldav.js";
import { createSyncService } from "./sync.js";

function unixNow() {
  return Math.floor(Date.now() / 1000);
}

async function main() {
  const config = loadConfig();
  const db = openDb(config.db.path);
  if (config.nostr.bunkerUrl) {
    console.warn("NIP-46 bunker_url is configured but not implemented yet; using local private key mode.");
  }

  const publisher = createNostrPublisher({
    relays: config.nostr.relays,
    privateKey: config.nostr.privateKey
  });

  const syncService = createSyncService({ db, publisher });
  const since = unixNow() - config.sync.lookbackDays * 24 * 60 * 60;

  const subscriber = new NostrSubscriber({
    relays: config.nostr.relays,
    authors: config.nostr.followPubkeys,
    since,
    onIssue: (event) => {
      syncService.onIssueEvent(event, "multi-relay");
    },
    onStatus: (event) => {
      syncService.onStatusEvent(event);
    },
    onComment: (event) => {
      syncService.onCommentEvent(event);
    }
  });

  subscriber.start();

  const app = createCaldavServer({
    db,
    caldavConfig: config.caldav,
    syncService
  });

  const server = app.listen(config.caldav.port, config.caldav.host, () => {
    console.log(`CalDAV server listening on ${config.caldav.host}:${config.caldav.port}`);
    console.log(`Nostr writeback enabled: ${publisher.enabled ? "yes" : "no"}`);
  });

  const shutdown = () => {
    subscriber.stop();
    syncService.close();
    server.close(() => {
      db.close();
      process.exit(0);
    });
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
