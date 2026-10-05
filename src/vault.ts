import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * The credential vault: AES-256-GCM encryption of users' provider keys and
 * GitHub tokens at rest in the gateway store.
 *
 * Keys come from a keyring, `FM_WT_VAULT_KEYS="k1:<base64 32 bytes>[,k2:...]"`,
 * held in a Secret injected only into the gateway. New writes use the active
 * key id (`FM_WT_VAULT_ACTIVE_KEY`); every sealed value records the id it was
 * sealed under, so an old key keeps decrypting until `vault rotate` re-seals
 * every row under the active one and the old id can leave the keyring.
 *
 * Each value is bound to its owner and slot through the additional
 * authenticated data: "walkie-talkie/credential/v1" 0x00 user_id 0x00 name
 * 0x00 kid. A row copied to another user or another credential name, or
 * relabelled with another key id, fails to open instead of injecting the wrong
 * key. Errors never carry the plaintext, the ciphertext or a key.
 */

export const VAULT_AAD_PREFIX = "walkie-talkie/credential/v1";
const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
export const KEY_ID_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;

export class VaultError extends Error {
  override name = "VaultError";
}

/** A sealed credential as stored: the key id and nonce ‖ ciphertext ‖ tag. */
export interface SealedValue {
  kid: string;
  blob: Uint8Array;
}

/**
 * Parse `k1:<base64>,k2:<base64>`. Each key must decode to exactly 32 bytes and
 * ids must be unique. The message never includes a key's value.
 */
export function parseKeyring(value: string): Map<string, Buffer> {
  const keyring = new Map<string, Buffer>();
  const entries = value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (entries.length === 0) throw new VaultError("the vault keyring is empty");
  for (const entry of entries) {
    const colon = entry.indexOf(":");
    const kid = colon === -1 ? "" : entry.slice(0, colon).trim();
    if (!KEY_ID_PATTERN.test(kid)) {
      throw new VaultError("each vault keyring entry must be <id>:<base64 key> with an id of letters, digits, _ or -");
    }
    if (keyring.has(kid)) throw new VaultError(`vault key id ${kid} appears twice in the keyring`);
    const encoded = entry.slice(colon + 1).trim();
    const key = /^[A-Za-z0-9+/_-]+={0,2}$/.test(encoded) ? Buffer.from(encoded, "base64") : Buffer.alloc(0);
    if (key.length !== KEY_BYTES) {
      throw new VaultError(`vault key ${kid} must be ${KEY_BYTES} bytes of base64 (openssl rand -base64 32)`);
    }
    keyring.set(kid, key);
  }
  return keyring;
}

/** The additional authenticated data that binds a sealed value to its slot. */
export function credentialAad(userId: string, name: string, kid: string): Buffer {
  return Buffer.from(`${VAULT_AAD_PREFIX}\0${userId}\0${name}\0${kid}`, "utf8");
}

/** Overwrite a buffer holding plaintext; best effort, as JavaScript allows. */
export function wipe(buffer: Uint8Array | null | undefined): void {
  buffer?.fill(0);
}

export class Vault {
  private readonly keys: Map<string, Buffer>;
  readonly activeKid: string;

  constructor(keys: Map<string, Buffer>, activeKid: string) {
    if (!keys.has(activeKid)) {
      throw new VaultError(`the active vault key ${activeKid} is not in the keyring`);
    }
    this.keys = keys;
    this.activeKid = activeKid;
  }

  /** Build from the two settings, as the gateway's environment carries them. */
  static fromSettings(keyring: string, activeKid: string): Vault {
    if (!KEY_ID_PATTERN.test(activeKid)) throw new VaultError("the active vault key id is malformed");
    return new Vault(parseKeyring(keyring), activeKid);
  }

  /** Key ids in the keyring (never the keys). */
  keyIds(): string[] {
    return [...this.keys.keys()];
  }

  /** Seal `plaintext` for (userId, name) under the active key. */
  seal(userId: string, name: string, plaintext: Uint8Array): SealedValue {
    const kid = this.activeKid;
    const key = this.keys.get(kid);
    if (key === undefined) throw new VaultError("the active vault key is missing");
    const nonce = randomBytes(NONCE_BYTES);
    const cipher = createCipheriv("aes-256-gcm", key, nonce, { authTagLength: TAG_BYTES });
    cipher.setAAD(credentialAad(userId, name, kid));
    const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const blob = Buffer.concat([nonce, body, cipher.getAuthTag()]);
    wipe(body);
    return { kid, blob };
  }

  /**
   * Open a sealed value for (userId, name). Throws a VaultError for an unknown
   * key id, a truncated value, or any authentication failure: tampering, a
   * different owner or slot, or a relabelled key id. The caller wipes the
   * returned buffer once it is done with it.
   */
  open(userId: string, name: string, sealed: SealedValue): Buffer {
    const key = this.keys.get(sealed.kid);
    if (key === undefined) throw new VaultError(`vault key ${sealed.kid} is not in the keyring`);
    const blob = Buffer.from(sealed.blob);
    if (blob.length < NONCE_BYTES + TAG_BYTES) throw new VaultError("a sealed credential is truncated");
    const nonce = blob.subarray(0, NONCE_BYTES);
    const tag = blob.subarray(blob.length - TAG_BYTES);
    const body = blob.subarray(NONCE_BYTES, blob.length - TAG_BYTES);
    const decipher = createDecipheriv("aes-256-gcm", key, nonce, { authTagLength: TAG_BYTES });
    decipher.setAAD(credentialAad(userId, name, sealed.kid));
    decipher.setAuthTag(tag);
    const first = decipher.update(body);
    try {
      return Buffer.concat([first, decipher.final()]);
    } catch {
      throw new VaultError("a sealed credential failed authentication");
    } finally {
      wipe(first);
    }
  }
}
