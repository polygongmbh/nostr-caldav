import { createHash } from "node:crypto";
import { decrypt } from "nostr-tools/nip49";
import { createLocalSignerFromPrivateKey } from "./signer.js";

function stripTrailingSlash(value) {
  return String(value || "").replace(/\/+$/, "");
}

function normalizeApiPrefix(value) {
  const raw = String(value || "/api/v1").trim();
  if (!raw) return "/api/v1";
  const withLeading = raw.startsWith("/") ? raw : `/${raw}`;
  return withLeading.replace(/\/+$/, "");
}

function normalizeRelayUrl(value) {
  const raw = String(value || "").trim().toLowerCase().replace(/\/+$/, "");
  if (!raw) return null;
  if (raw.startsWith("wss://") || raw.startsWith("ws://")) return raw;
  return `wss://${raw}`;
}

function parseHandle(handle) {
  const raw = String(handle || "").trim().toLowerCase();
  const firstAt = raw.indexOf("@");
  if (firstAt <= 0 || firstAt === raw.length - 1) {
    throw new Error("Expected NOAS handle in form username@domain");
  }
  const username = raw.slice(0, firstAt);
  const rest = raw.slice(firstAt + 1);
  const secondAt = rest.indexOf("@");
  if (secondAt <= 0) {
    return { username, domain: rest, relayFilter: null };
  }
  const domain = rest.slice(0, secondAt);
  const relay = rest.slice(secondAt + 1);
  if (!domain || !relay) {
    throw new Error("Expected NOAS handle in form username@domain or username@domain@relay");
  }
  return { username, domain, relayFilter: normalizeRelayUrl(relay) };
}

function sha256Hex(value) {
  return createHash("sha256").update(String(value || ""), "utf8").digest("hex");
}

async function fetchJsonWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const text = await response.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }
    return { ok: response.ok, status: response.status, data, text };
  } finally {
    clearTimeout(timer);
  }
}

export function createNoasAuthProvider(noasConfig, options = {}) {
  const cache = new Map();
  const enabled = noasConfig?.enabled === true && noasConfig?.caldavAuthEnabled === true;
  const timeoutMs = Number(noasConfig?.timeoutMs) || 10000;
  const apiPrefix = normalizeApiPrefix(noasConfig?.apiPathPrefix);
  const ttlMs = Math.max(0, Number(noasConfig?.cacheTtlMs) || 300000);
  const cacheMode = String(noasConfig?.cacheMode || "encrypted").toLowerCase();

  function resolveBaseUrl(domain) {
    const explicit = noasConfig?.domainBaseUrls?.[domain];
    if (explicit) return stripTrailingSlash(explicit);
    if (noasConfig?.baseUrl) return stripTrailingSlash(noasConfig.baseUrl);
    return `https://noas.${domain}`;
  }

  async function signin({ username, domain, password }) {
    const baseUrl = resolveBaseUrl(domain);
    const url = `${baseUrl}${apiPrefix}/auth/signin`;
    const payload = { username, password };
    const result = await fetchJsonWithTimeout(
      url,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      },
      timeoutMs
    );

    if (!result.ok || !result.data?.success) {
      const message = result.data?.error || `NOAS sign-in failed (${result.status})`;
      throw new Error(message);
    }

    const publicKey = String(result.data?.public_key || "").trim();
    const encryptedKey = String(result.data?.private_key_encrypted || "").trim();
    if (!publicKey || !encryptedKey) {
      throw new Error("NOAS account does not expose key material for signing.");
    }

    return {
      username,
      domain,
      handle: `${username}@${domain}`,
      baseUrl,
      publicKey,
      encryptedKey,
      relays: Array.isArray(result.data?.relays) ? result.data.relays : []
    };
  }

  async function getAuthContext(handle, password) {
    if (!enabled) return null;
    const { username, domain, relayFilter } = parseHandle(handle);
    const passwordHash = sha256Hex(password);
    const cacheKey = `${username}@${domain}:${relayFilter || ""}:${passwordHash}`;
    const now = Date.now();
    let session = cache.get(cacheKey);

    if (!session || session.expiresAt <= now) {
      const signedIn = await signin({ username, domain, password });
      session = {
        ...signedIn,
        expiresAt: now + ttlMs
      };
      cache.set(cacheKey, session);
      if (typeof options.onAuthenticatedPubkey === "function") {
        options.onAuthenticatedPubkey(session.publicKey, session.handle);
      }
    }

    let signer = null;
    if (cacheMode === "decrypted" && session.privateKeyHex) {
      signer = createLocalSignerFromPrivateKey(session.privateKeyHex);
    } else {
      const decrypted = await decrypt(session.encryptedKey, password);
      const privateKeyHex = Buffer.from(decrypted).toString("hex");
      signer = createLocalSignerFromPrivateKey(privateKeyHex);
      if (cacheMode === "decrypted") {
        session.privateKeyHex = privateKeyHex;
      }
    }

    // Use the full handle (including relay) as the principal username so that
    // relay-filtered accounts get their own calendar home URL and don't collide
    // with the base account in CalDAV clients.
    const principalUsername = relayFilter
      ? `${session.handle}@${relayFilter.replace(/^wss?:\/\//, "")}`
      : session.handle;

    return {
      principal: {
        username: principalUsername,
        password: "__noas_external__",
        pubkeys: [session.publicKey],
        calendars: [],
        relayFilter: relayFilter || null
      },
      signer,
      noas: {
        handle: session.handle,
        username: session.username,
        domain: session.domain,
        baseUrl: session.baseUrl,
        relayFilter: relayFilter || null
      }
    };
  }

  return {
    enabled,
    async authenticate(handle, password) {
      return getAuthContext(handle, password);
    }
  };
}
