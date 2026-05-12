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

function parseHandle(handle) {
  const raw = String(handle || "").trim().toLowerCase();
  const at = raw.indexOf("@");
  if (at <= 0 || at === raw.length - 1) {
    throw new Error("Expected NOAS handle in form username@domain");
  }
  return {
    username: raw.slice(0, at),
    domain: raw.slice(at + 1)
  };
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
    const { username, domain } = parseHandle(handle);
    const passwordHash = sha256Hex(password);
    const cacheKey = `${username}@${domain}:${passwordHash}`;
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

    return {
      principal: {
        username: session.handle,
        password: "__noas_external__",
        pubkeys: [session.publicKey],
        calendars: []
      },
      signer,
      noas: {
        handle: session.handle,
        username: session.username,
        domain: session.domain,
        baseUrl: session.baseUrl
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
