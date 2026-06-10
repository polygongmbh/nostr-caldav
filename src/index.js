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
  const authCatchupWindowDays = 365;
  const authCatchupSince = unixNow() - authCatchupWindowDays * 24 * 60 * 60;

  subscriber = new NostrSubscriber({
    relays: config.nostr.relays,
    authors: trackedPubkeys,
    since,
    onIssue: (event, relayUrl) => {
      syncService.onIssueEvent(event, relayUrl);
    },
    onStatus: (event) => {
      syncService.onStatusEvent(event);
    },
    onComment: (event) => {
      syncService.onCommentEvent(event);
    },
    onCalendarEvent: (event, relayUrl) => {
      syncService.onCalendarEvent(event, relayUrl);
    },
    onauth: authSigner
  });

  subscriber.start();

  // Re-subscribe all pubkeys already in the DB so live updates work immediately
  // even before users authenticate in this session. Without this, follow_pubkeys: []
  // means no subscriptions are active until someone logs in via CalDAV.
  const knownPubkeys = db.listDistinctIssuePubkeys();
  for (const pubkey of knownPubkeys) {
    if (!trackedPubkeys.includes(pubkey)) {
      trackedPubkeys.push(pubkey);
      subscriber.addAuthor(pubkey);
    }
  }
  if (knownPubkeys.length > 0) {
    console.log(`Re-subscribed ${knownPubkeys.length} known pubkeys from DB`);
  }

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

  const parentCandidateIds = db.listIssueEventIds(5000);
  if (parentCandidateIds.length > 0) {
    console.log(`Backfill: refetching child tasks for ${parentCandidateIds.length} known parent candidates`);
    try {
      const result = await subscriber.refetchIssuesByParentIds(parentCandidateIds, {
        chunkSize: 200,
        timeoutMs: 12000
      });
      console.log(`Child task backfill complete: requested=${result.requested} chunks=${result.chunks}`);
    } catch (error) {
      console.error("Child task backfill failed", error);
    }
  }

  const statusBackfillIssueIds = db.listIssueEventIds(10000);
  if (statusBackfillIssueIds.length > 0) {
    console.log(`Backfill: refetching status events for ${statusBackfillIssueIds.length} known issues`);
    try {
      const result = await subscriber.refetchStatusEventsByIssueIds(statusBackfillIssueIds, {
        chunkSize: 200,
        timeoutMs: 12000,
        since
      });
      console.log(`Status backfill complete: requested=${result.requested} chunks=${result.chunks}`);
    } catch (error) {
      console.error("Status backfill failed", error);
    }
  }

  // Backfill calendar events for all known pubkeys
  const calendarBackfillPubkeys = db.listDistinctIssuePubkeys();
  if (calendarBackfillPubkeys.length > 0) {
    console.log(`Backfill: fetching calendar events for ${calendarBackfillPubkeys.length} known pubkeys`);
    try {
      const result = await subscriber.refetchCalendarEventsByAuthors(calendarBackfillPubkeys, {
        chunkSize: 50,
        timeoutMs: 12000,
        since
      });
      const calCount = db.listCalendarEventsFiltered({}).length;
      console.log(`Calendar event backfill complete: requested=${result.requested} chunks=${result.chunks} stored=${calCount}`);
    } catch (error) {
      console.error("Calendar event backfill failed", error);
    }
  }

  async function runRelayCatchup(pubkey, relayUrl) {
    const markerKey = `relay_catchup_v1:${pubkey}:${relayUrl}`;
    if (db.getConfigValue(markerKey) === "complete") return;
    try {
      console.log(`Relay catch-up: fetching from ${relayUrl} for ${pubkey.slice(0, 12)}`);
      await subscriber.catchupAuthorOnRelay(pubkey, relayUrl, authCatchupSince);
      db.setConfigValue(markerKey, "complete");
      console.log(`Relay catch-up complete: ${relayUrl} for ${pubkey.slice(0, 12)}`);
    } catch (error) {
      console.error(`Relay catch-up failed for ${pubkey.slice(0, 12)}@${relayUrl}`, error);
    }
  }

  async function runUserCatchup(pubkey) {
    const markerKey = `user_catchup_v2:${pubkey}`;
    if (db.getConfigValue(markerKey) === "complete") return;

    try {
      console.log(`Catch-up: refetching authored issues for ${pubkey.slice(0, 12)} since ${authCatchupSince}`);
      const authored = await subscriber.refetchIssuesByAuthors([pubkey], {
        chunkSize: 50,
        timeoutMs: 12000,
        since: authCatchupSince
      });
      console.log(`Catch-up: authored requested=${authored.requested} chunks=${authored.chunks}`);

      console.log(`Catch-up: refetching assigned issues for ${pubkey.slice(0, 12)} since ${authCatchupSince}`);
      const assigned = await subscriber.refetchIssuesByMentionPubkeys([pubkey], {
        chunkSize: 50,
        timeoutMs: 12000,
        since: authCatchupSince
      });
      console.log(`Catch-up: assigned requested=${assigned.requested} chunks=${assigned.chunks}`);

      const parentIds = db.listIssueEventIds(10000);
      if (parentIds.length > 0) {
        const children = await subscriber.refetchIssuesByParentIds(parentIds, {
          chunkSize: 200,
          timeoutMs: 12000
        });
        console.log(`Catch-up: child-refetch requested=${children.requested} chunks=${children.chunks}`);

        const statuses = await subscriber.refetchStatusEventsByIssueIds(parentIds, {
          chunkSize: 200,
          timeoutMs: 12000,
          since: authCatchupSince
        });
        console.log(`Catch-up: status-refetch requested=${statuses.requested} chunks=${statuses.chunks}`);
      }

      db.setConfigValue(markerKey, "complete");
    } catch (error) {
      console.error(`Catch-up failed for ${pubkey.slice(0, 12)}`, error);
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
      const relayFilter = authContext?.noas?.relayFilter || null;
      if (subscriber) {
        subscriber.addAuthor(normalized, authContext.signer || null);
        if (relayFilter) {
          // Dynamically extend the relay set and subscribe this author to the filtered relay.
          if (!subscriber.relays.includes(relayFilter)) {
            subscriber.relays.push(relayFilter);
            console.log(`Dynamically added relay ${relayFilter} from login`);
          }
          subscriber.subscribeAuthorToRelay(normalized, relayFilter);
          runRelayCatchup(normalized, relayFilter).catch((error) => {
            console.error("Background relay catch-up error", error);
          });
        }
        runUserCatchup(normalized).catch((error) => {
          console.error("Background catch-up error", error);
        });
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
