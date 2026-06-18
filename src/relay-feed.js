import { SimplePool, useWebSocketImplementation } from "nostr-tools/pool";
import WebSocket from "ws";
import { CALENDAR_EVENT_DATE_KIND, CALENDAR_EVENT_TIME_KIND } from "./status.js";

export async function fetchRelayCalendarFeed(relayUrl, { timeoutMs = 10000, limit = 500 } = {}) {
  useWebSocketImplementation(WebSocket);
  const pool = new SimplePool();
  // Deduplicate NIP-52 replaceable events: keep newest per (pubkey, kind, d-tag)
  const seen = new Map();

  try {
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

      const sub = pool.subscribeMany(
        [relayUrl],
        [{ kinds: [CALENDAR_EVENT_DATE_KIND, CALENDAR_EVENT_TIME_KIND], limit }],
        {
          onevent(event) {
            const dTag = (event.tags || []).find((t) => t[0] === "d")?.[1] ?? "";
            // Skip task-linked due-date events — internal bridge artefacts
            if (dTag.startsWith("task-date-")) return;
            const key = `${event.pubkey}:${event.kind}:${dTag}`;
            const existing = seen.get(key);
            if (!existing || event.created_at > existing.created_at) {
              seen.set(key, event);
            }
          },
          oneose: finish,
          onclose: finish
        }
      );
    });
  } finally {
    pool.close([relayUrl]);
  }

  return Array.from(seen.values()).sort((a, b) => b.created_at - a.created_at);
}
