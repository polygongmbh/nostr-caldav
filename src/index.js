import { loadConfig } from "./config.js";
import { openDb } from "./db.js";
import { NostrSubscriber } from "./nostr.js";
import { createCaldavServer } from "./caldav.js";

function unixNow() {
  return Math.floor(Date.now() / 1000);
}

async function main() {
  const config = loadConfig();
  const db = openDb(config.db.path);

  const since = unixNow() - config.sync.lookbackDays * 24 * 60 * 60;

  const subscriber = new NostrSubscriber({
    relays: config.nostr.relays,
    authors: config.nostr.followPubkeys,
    since,
    onIssue: (event) => {
      db.upsertIssueFromNostr(event, "multi-relay");
    }
  });

  subscriber.start();

  const app = createCaldavServer({
    db,
    caldavConfig: config.caldav
  });

  const server = app.listen(config.caldav.port, config.caldav.host, () => {
    console.log(`CalDAV server listening on ${config.caldav.host}:${config.caldav.port}`);
  });

  const shutdown = () => {
    subscriber.stop();
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
