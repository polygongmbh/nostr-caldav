import { loadConfig } from "./config.js";
import { openDb } from "./db.js";
import { NostrSubscriber, createNostrPublisher } from "./nostr.js";
import { createCaldavServer } from "./caldav.js";
import { createSyncService } from "./sync.js";
import { createBridgeSigner, createNip42AuthSigner } from "./signer.js";
import { createNoasAuthProvider } from "./noas-auth.js";

function unixNow() {
  return Math.floor(Date.now() / 1000);
}

async function main() {
  const config = loadConfig();
  const db = openDb(config.db.path);
  const trackedPubkeys = Array.from(new Set((config.nostr.followPubkeys || []).map((p) => String(p).toLowerCase())));
  let subscriber = null;
  const noasAuthProvider = createNoasAuthProvider(config.nostr.noas, {
    onAuthenticatedPubkey(pubkey, handle) {
      const normalized = String(pubkey || "").trim().toLowerCase();
      if (!/^[0-9a-f]{64}$/.test(normalized)) return;
      if (!trackedPubkeys.includes(normalized)) {
        trackedPubkeys.push(normalized);
        console.log(`Auto-tracking NOAS user pubkey for ${handle}`);
      }
    }
  });
  let resolvedBunkerUrl = null;

  if (!config.nostr.noas?.enabled || !config.nostr.noas?.caldavAuthEnabled) {
    throw new Error("NOAS-only mode required: set nostr.noas.enabled=true and nostr.noas.caldav_auth_enabled=true.");
  }

  resolvedBunkerUrl = null;

  const signer = await createBridgeSigner({
    privateKey: config.nostr.privateKey,
    bunkerUrl: resolvedBunkerUrl,
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

  subscriber = new NostrSubscriber({
    relays: config.nostr.relays,
    authors: trackedPubkeys,
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

  const missingBefore = db.listIssueEventIdsMissingChannelTags(5000);
  if (missingBefore.length > 0) {
    console.log(`Backfill: refetching ${missingBefore.length} legacy issues to recover tag metadata`);
    try {
      const result = await subscriber.refetchIssuesByIds(missingBefore, {
        chunkSize: 200,
        timeoutMs: 12000
      });
      const missingAfter = db.listIssueEventIdsMissingChannelTags(5000).length;
      const channelCount = db.listDistinctChannelTags().length;
      console.log(
        `Backfill complete: requested=${result.requested} chunks=${result.chunks} missing_after=${missingAfter} channels=${channelCount}`
      );
    } catch (error) {
      console.error("Backfill failed", error);
    }
  }

  if (db.getConfigValue("parent_metadata_backfill_v1") !== "complete") {
    const legacyIssueIds = db.listIssueEventIds(5000);
    if (legacyIssueIds.length > 0) {
      console.log(`Backfill: refetching ${legacyIssueIds.length} legacy issues to recover parent task metadata`);
      try {
        const result = await subscriber.refetchIssuesByIds(legacyIssueIds, {
          chunkSize: 200,
          timeoutMs: 12000
        });
        db.setConfigValue("parent_metadata_backfill_v1", "complete");
        console.log(`Parent metadata backfill complete: requested=${result.requested} chunks=${result.chunks}`);
      } catch (error) {
        console.error("Parent metadata backfill failed", error);
      }
    } else {
      db.setConfigValue("parent_metadata_backfill_v1", "complete");
    }
  }

  const app = createCaldavServer({
    db,
    caldavConfig: config.caldav,
    syncService,
    trackedPubkeys,
    noasAuthProvider,
    onAuthenticatedContext: (authContext) => {
      const pubkey = authContext?.principal?.pubkeys?.[0];
      const normalized = String(pubkey || "").trim().toLowerCase();
      if (!/^[0-9a-f]{64}$/.test(normalized)) return;
      if (!trackedPubkeys.includes(normalized)) {
        trackedPubkeys.push(normalized);
      }
      if (subscriber) {
        subscriber.addAuthor(normalized, authContext.signer || null);
      }
    }
  });

  const server = app.listen(config.caldav.port, config.caldav.host, () => {
    console.log(`CalDAV server listening on ${config.caldav.host}:${config.caldav.port}`);
    const perUserWriteback = config.nostr.noas?.enabled && config.nostr.noas?.caldavAuthEnabled;
    console.log(`Nostr writeback enabled: ${publisher.enabled || perUserWriteback ? "yes" : "no"}`);
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
