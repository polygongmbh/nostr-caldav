import { BunkerSigner, parseBunkerInput } from "nostr-tools/nip46";
import { finalizeEvent, generateSecretKey, getPublicKey, nip19 } from "nostr-tools";
import { webcrypto } from "node:crypto";

function ensureWebCrypto() {
  if (!globalThis.crypto) {
    globalThis.crypto = webcrypto;
  }
}

function decodePrivateKey(privateKey) {
  if (!privateKey) return null;

  if (privateKey.startsWith("nsec1")) {
    const decoded = nip19.decode(privateKey);
    if (decoded.type !== "nsec") {
      throw new Error(`Expected nsec private key, got ${decoded.type}`);
    }
    return decoded.data;
  }

  if (/^[0-9a-fA-F]{64}$/.test(privateKey)) {
    return Uint8Array.from(Buffer.from(privateKey, "hex"));
  }

  throw new Error("Unsupported private key format. Use nsec1... or 64-byte hex.");
}

function toHex(bytes) {
  return Buffer.from(bytes).toString("hex");
}

function fromHex(hex) {
  return Uint8Array.from(Buffer.from(hex, "hex"));
}

function localSigner(privateKeyBytes) {
  ensureWebCrypto();
  return {
    mode: "local",
    enabled: true,
    pubkey: getPublicKey(privateKeyBytes),
    async signEvent(eventTemplate) {
      return finalizeEvent(eventTemplate, privateKeyBytes);
    },
    async close() {}
  };
}

export function createLocalSignerFromPrivateKey(privateKey) {
  const privateKeyBytes = decodePrivateKey(privateKey);
  if (!privateKeyBytes) {
    throw new Error("Missing private key");
  }
  return localSigner(privateKeyBytes);
}

async function bunkerSigner({ bunkerUrl, relays, db }) {
  ensureWebCrypto();
  const existingClientSecret = db.getConfigValue("bunker_client_secret_hex");
  const clientSecret = existingClientSecret ? fromHex(existingClientSecret) : generateSecretKey();

  if (!existingClientSecret) {
    db.setConfigValue("bunker_client_secret_hex", toHex(clientSecret));
  }

  const pointer = await parseBunkerInput(bunkerUrl);
  if (!pointer) {
    throw new Error("Invalid bunker_url; expected bunker://... or supported NIP-05 identifier");
  }

  const signer = BunkerSigner.fromBunker(clientSecret, pointer, {
    pool: undefined,
    onauth: (url) => {
      console.log(`NIP-46 bunker auth requested at ${url}`);
    }
  });

  await signer.connect();
  const pubkey = await signer.getPublicKey();

  return {
    mode: "nip46",
    enabled: true,
    pubkey,
    async signEvent(eventTemplate) {
      return signer.signEvent(eventTemplate);
    },
    async close() {
      await signer.close();
    },
    relays
  };
}

export async function createBridgeSigner({ privateKey, bunkerUrl, relays, db }) {
  if (bunkerUrl) {
    return bunkerSigner({ bunkerUrl, relays, db });
  }

  const privateKeyBytes = decodePrivateKey(privateKey);
  if (privateKeyBytes) {
    return localSigner(privateKeyBytes);
  }

  return {
    mode: "disabled",
    enabled: false,
    pubkey: null,
    async signEvent() {
      throw new Error("No signer configured");
    },
    async close() {}
  };
}

export function createNip42AuthSigner(signer) {
  if (!signer?.enabled) return null;

  return async (eventTemplate) => signer.signEvent(eventTemplate);
}
