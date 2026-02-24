import { loadConfig } from "./config.js";
import { openDb } from "./db.js";
import { NostrSubscriber, createNostrPublisher } from "./nostr.js";
import { createCaldavServer } from "./caldav.js";
import { createSyncService } from "./sync.js";
import { createBridgeSigner, createNip42AuthSigner } from "./signer.js";

function unixNow() {
  return Math.floor(Date.now() / 1000);
}

async function main() {
  const config = loadConfig();
  const db = openDb(config.db.path);
  const signer = await createBridgeSigner({
    privateKey: config.nostr.privateKey,
    bunkerUrl: config.nostr.bunkerUrl,
    relays: config.nostr.relays,
    db
  });
  const authSigner = createNip42AuthSigner(signer);

  const publisher = createNostrPublisher({
    relays: config.nostr.relays,
    signer,
    onauth: authSigner
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
    },
    onauth: authSigner
  });

  subscriber.start();

  const app = createCaldavServer({
    db,
    caldavConfig: config.caldav,
    syncService,
    trackedPubkeys: config.nostr.followPubkeys
  });

  const server = app.listen(config.caldav.port, config.caldav.host, () => {
    console.log(`CalDAV server listening on ${config.caldav.host}:${config.caldav.port}`);
    console.log(`Nostr writeback enabled: ${publisher.enabled ? "yes" : "no"}`);
    console.log(`Signer mode: ${signer.mode}`);
  });

  const shutdown = () => {
    subscriber.stop();
    syncService.close();
    signer.close();
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
