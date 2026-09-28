import {
  createCipheriv,
  createECDH,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  sign,
  verify,
  type KeyObject,
} from "node:crypto";

/**
 * Self-hosted Web Push primitives built only on Node's `crypto` module.
 *
 * The service deliberately carries no runtime dependency, so VAPID (RFC 8292)
 * and payload encryption (RFC 8291 / RFC 8188 `aes128gcm`) are implemented
 * here against the public RFC test vectors. Nothing in this file talks to a
 * third-party account or service: it only knows the browser push endpoint the
 * subscription itself supplies.
 */

export interface VapidKeys {
  publicKey: string;
  privateKey: string;
}

export interface PushSubscriptionKeys {
  p256dh: string;
  auth: string;
}

export interface PushSubscription {
  endpoint: string;
  keys: PushSubscriptionKeys;
}

export interface PushMessage {
  title: string;
  body: string;
  url: string;
  tag?: string;
}

export interface PushSendResult {
  status: number;
  /** The push service reported the subscription is gone and it should be dropped. */
  gone: boolean;
}

export interface PushSender {
  send(subscription: PushSubscription, message: PushMessage): Promise<PushSendResult>;
}

const CURVE = "prime256v1";
const PUSH_INFO = Buffer.from("WebPush: info\0", "utf8");
const CEK_INFO = Buffer.from("Content-Encoding: aes128gcm\0", "utf8");
const NONCE_INFO = Buffer.from("Content-Encoding: nonce\0", "utf8");
const RECORD_SIZE = 4096;
const VAPID_TOKEN_TTL_SECONDS = 12 * 60 * 60;

export function b64urlEncode(buffer: Buffer): string {
  return buffer.toString("base64url");
}

export function b64urlDecode(value: string): Buffer {
  return Buffer.from(value, "base64url");
}

function publicKeyObject(publicKey: string): KeyObject {
  const raw = b64urlDecode(publicKey);
  if (raw.length !== 65 || raw[0] !== 0x04) {
    throw new Error("VAPID public key must be an uncompressed P-256 point");
  }
  return createPublicKey({
    key: {
      kty: "EC",
      crv: "P-256",
      x: raw.subarray(1, 33).toString("base64url"),
      y: raw.subarray(33, 65).toString("base64url"),
    },
    format: "jwk",
  });
}

function privateKeyObject(privateKey: string): KeyObject {
  const d = b64urlDecode(privateKey);
  if (d.length !== 32) throw new Error("VAPID private key must be 32 bytes");
  const ecdh = createECDH(CURVE);
  ecdh.setPrivateKey(d);
  const point = ecdh.getPublicKey();
  return createPrivateKey({
    key: {
      kty: "EC",
      crv: "P-256",
      d: d.toString("base64url"),
      x: point.subarray(1, 33).toString("base64url"),
      y: point.subarray(33, 65).toString("base64url"),
    },
    format: "jwk",
  });
}

export function isValidVapidPublicKey(value: string): boolean {
  try {
    const raw = b64urlDecode(value);
    return raw.length === 65 && raw[0] === 0x04;
  } catch {
    return false;
  }
}

export function isValidVapidPrivateKey(value: string): boolean {
  try {
    return b64urlDecode(value).length === 32;
  } catch {
    return false;
  }
}

/** Generate a fresh VAPID key pair in the base64url format the browser expects. */
export function generateVapidKeys(): VapidKeys {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: CURVE });
  const jwk = privateKey.export({ format: "jwk" }) as { d?: string; x?: string; y?: string };
  if (!jwk.d || !jwk.x || !jwk.y) throw new Error("failed to export generated VAPID key");
  const point = Buffer.concat([
    Buffer.from([0x04]),
    Buffer.from(jwk.x, "base64url"),
    Buffer.from(jwk.y, "base64url"),
  ]);
  return { publicKey: point.toString("base64url"), privateKey: jwk.d };
}

function encodeJwtSegment(value: unknown): string {
  return b64urlEncode(Buffer.from(JSON.stringify(value), "utf8"));
}

/**
 * Build the `Authorization` header for one push endpoint. The audience is the
 * origin of the endpoint itself and the token is signed with ES256.
 */
export function vapidAuthorizationHeader(
  endpoint: string,
  keys: VapidKeys,
  subject: string,
  now: Date = new Date(),
): string {
  const audience = new URL(endpoint).origin;
  const header = encodeJwtSegment({ typ: "JWT", alg: "ES256" });
  const exp = Math.floor(now.getTime() / 1000) + VAPID_TOKEN_TTL_SECONDS;
  const payload = encodeJwtSegment({ aud: audience, exp, sub: subject });
  const signingInput = `${header}.${payload}`;
  const signature = sign("sha256", Buffer.from(signingInput, "utf8"), {
    key: privateKeyObject(keys.privateKey),
    dsaEncoding: "ieee-p1363",
  });
  const jwt = `${signingInput}.${b64urlEncode(signature)}`;
  return `vapid t=${jwt}, k=${keys.publicKey}`;
}

/** Verify a VAPID header's JWT. Exported for tests; the service never calls it. */
export function verifyVapidAuthorization(header: string, publicKey: string): boolean {
  const match = /^vapid t=([^,\s]+),\s*k=(\S+)$/.exec(header);
  if (!match) return false;
  const [, jwt, k] = match;
  if (jwt === undefined) return false;
  if (k !== undefined && k !== publicKey) return false;
  const parts = jwt.split(".");
  if (parts.length !== 3) return false;
  const [headerSegment, payloadSegment, signatureSegment] = parts;
  if (headerSegment === undefined || payloadSegment === undefined || signatureSegment === undefined) {
    return false;
  }
  try {
    return verify(
      "sha256",
      Buffer.from(`${headerSegment}.${payloadSegment}`, "utf8"),
      { key: publicKeyObject(publicKey), dsaEncoding: "ieee-p1363" },
      b64urlDecode(signatureSegment),
    );
  } catch {
    return false;
  }
}

export interface EncryptOptions {
  salt?: Buffer;
  ephemeralPrivateKey?: string;
  ephemeralPublicKey?: string;
  recordSize?: number;
}

function uint32be(value: number): Buffer {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32BE(value >>> 0, 0);
  return buffer;
}

/**
 * Encrypt one push message for one subscription per RFC 8291. The returned
 * buffer is the full `aes128gcm` body: header || ciphertext || tag. Tests pin
 * the RFC 8291 Appendix A vector by injecting the salt and ephemeral key.
 */
export function encryptPayload(
  message: Buffer,
  subscription: PushSubscription,
  options: EncryptOptions = {},
): Buffer {
  const uaPublic = b64urlDecode(subscription.keys.p256dh);
  const authSecret = b64urlDecode(subscription.keys.auth);
  if (uaPublic.length !== 65 || uaPublic[0] !== 0x04) {
    throw new Error("subscription p256dh must be an uncompressed P-256 point");
  }
  if (authSecret.length !== 16) throw new Error("subscription auth secret must be 16 bytes");

  let ephemeralPrivate: Buffer;
  let ephemeralPublic: Buffer;
  if (options.ephemeralPrivateKey && options.ephemeralPublicKey) {
    ephemeralPrivate = b64urlDecode(options.ephemeralPrivateKey);
    ephemeralPublic = b64urlDecode(options.ephemeralPublicKey);
  } else {
    const ecdh = createECDH(CURVE);
    ecdh.generateKeys();
    ephemeralPrivate = ecdh.getPrivateKey();
    ephemeralPublic = ecdh.getPublicKey();
  }

  const ecdh = createECDH(CURVE);
  ecdh.setPrivateKey(ephemeralPrivate);
  const sharedSecret = ecdh.computeSecret(uaPublic);

  const salt = options.salt ?? randomBytes(16);
  const recordSize = options.recordSize ?? RECORD_SIZE;

  const ikm = Buffer.from(
    hkdfSync("sha256", sharedSecret, authSecret, Buffer.concat([PUSH_INFO, uaPublic, ephemeralPublic]), 32),
  );
  const cek = Buffer.from(hkdfSync("sha256", ikm, salt, CEK_INFO, 16));
  const nonce = Buffer.from(hkdfSync("sha256", ikm, salt, NONCE_INFO, 12));

  const header = Buffer.concat([salt, uint32be(recordSize), Buffer.from([ephemeralPublic.length]), ephemeralPublic]);
  const record = Buffer.concat([message, Buffer.from([0x02])]);

  // RFC 8188 `aes128gcm` (unlike the older `aesgcm` draft) passes no associated
  // data to AES-GCM; the header only carries the salt/record size/sender key.
  const cipher = createCipheriv("aes-128-gcm", cek, nonce);
  const ciphertext = Buffer.concat([cipher.update(record), cipher.final(), cipher.getAuthTag()]);
  return Buffer.concat([header, ciphertext]);
}

export function messageToPayload(message: PushMessage): Buffer {
  return Buffer.from(
    JSON.stringify({ title: message.title, body: message.body, url: message.url, tag: message.tag }),
    "utf8",
  );
}

export type FetchLike = (
  input: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: Buffer;
  },
) => Promise<{ status: number }>;

/** Sends encrypted notifications to a browser push endpoint over HTTPS. */
export class HttpPushSender implements PushSender {
  private readonly keys: VapidKeys;
  private readonly subject: string;
  private readonly fetchImpl: FetchLike;

  constructor(keys: VapidKeys, subject: string, fetchImpl?: FetchLike) {
    this.keys = keys;
    this.subject = subject;
    this.fetchImpl = fetchImpl ?? ((input, init) => fetch(input, init));
  }

  async send(subscription: PushSubscription, message: PushMessage): Promise<PushSendResult> {
    const body = encryptPayload(messageToPayload(message), subscription);
    const response = await this.fetchImpl(subscription.endpoint, {
      method: "POST",
      headers: {
        "content-encoding": "aes128gcm",
        "content-type": "application/octet-stream",
        ttl: "2419200",
        urgency: "normal",
        authorization: vapidAuthorizationHeader(subscription.endpoint, this.keys, this.subject),
      },
      body,
    });
    return { status: response.status, gone: response.status === 404 || response.status === 410 };
  }
}
