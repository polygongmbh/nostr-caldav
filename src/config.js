import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import { nip19 } from "nostr-tools";

const DEFAULT_CONFIG_PATH = process.env.BRIDGE_CONFIG || path.resolve(process.cwd(), "config.yaml");

function toHexPubkey(pubkey) {
  if (!pubkey) return pubkey;
  if (pubkey.startsWith("npub1")) {
    const decoded = nip19.decode(pubkey);
    if (decoded.type !== "npub") {
      throw new Error(`Expected npub key, got ${decoded.type}`);
    }
    return decoded.data;
  }
  return pubkey;
}

export function loadConfig(configPath = DEFAULT_CONFIG_PATH) {
  if (!fs.existsSync(configPath)) {
    throw new Error(`Config file not found: ${configPath}`);
  }

  const raw = fs.readFileSync(configPath, "utf8");
  const parsed = yaml.load(raw);

  const config = {
    nostr: {
      relays: parsed?.nostr?.relays || [],
      followPubkeys: (parsed?.nostr?.follow_pubkeys || []).map(toHexPubkey),
      privateKey: parsed?.nostr?.private_key || null,
      bunkerUrl: parsed?.nostr?.bunker_url || null
    },
    caldav: {
      host: parsed?.caldav?.host || "0.0.0.0",
      port: parsed?.caldav?.port || 5232,
      baseUrl: parsed?.caldav?.base_url || "http://localhost:5232",
      username: parsed?.caldav?.username || "user",
      password: parsed?.caldav?.password || "password"
    },
    sync: {
      pollIntervalSeconds: parsed?.sync?.poll_interval_seconds || 30,
      lookbackDays: parsed?.sync?.lookback_days || 90
    },
    db: {
      path: parsed?.db?.path || path.resolve(process.cwd(), "bridge.db")
    }
  };

  if (config.nostr.relays.length === 0) {
    throw new Error("No Nostr relays configured.");
  }

  return config;
}
