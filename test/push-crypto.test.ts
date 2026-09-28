import { test } from "node:test";
import assert from "node:assert/strict";
import { createDecipheriv, createECDH, hkdfSync, randomBytes } from "node:crypto";

import {
  b64urlDecode,
  b64urlEncode,
  encryptPayload,
  generateVapidKeys,
  isValidVapidPrivateKey,
  isValidVapidPublicKey,
  vapidAuthorizationHeader,
  verifyVapidAuthorization,
  type PushSubscription,
} from "../src/webpush.js";

// RFC 8291, Appendix A: a complete worked example with fixed keys and salt.
const RFC8291 = {
  plaintext: "When I grow up, I want to be a watermelon",
  uaPublic: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
  authSecret: "BTBZMqHH6r4Tts7J_aSIgg",
  salt: "DGv6ra1nlYgDCS1FRnbzlw",
  asPrivate: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
  asPublic: "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
  body: "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
};

test("payload encryption matches the RFC 8291 Appendix A vector", () => {
  const body = encryptPayload(
    Buffer.from(RFC8291.plaintext, "utf8"),
    {
      endpoint: "https://push.example.net/abc",
      keys: { p256dh: RFC8291.uaPublic, auth: RFC8291.authSecret },
    },
    {
      salt: b64urlDecode(RFC8291.salt),
      ephemeralPrivateKey: RFC8291.asPrivate,
      ephemeralPublicKey: RFC8291.asPublic,
    },
  );
  assert.equal(b64urlEncode(body), RFC8291.body);
});

function decryptedForClient(
  body: Buffer,
  clientPrivate: Buffer,
  clientPublic: Buffer,
  authSecret: Buffer,
): Buffer {
  const salt = body.subarray(0, 16);
  const idLength = body[20] ?? 0;
  const serverPublic = body.subarray(21, 21 + idLength);
  const ciphertext = body.subarray(21 + idLength);

  const ecdh = createECDH("prime256v1");
  ecdh.setPrivateKey(clientPrivate);
  const shared = ecdh.computeSecret(serverPublic);
  const ikm = Buffer.from(
    hkdfSync(
      "sha256",
      shared,
      authSecret,
      Buffer.concat([Buffer.from("WebPush: info\0", "utf8"), clientPublic, serverPublic]),
      32,
    ),
  );
  const cek = Buffer.from(
    hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0", "utf8"), 16),
  );
  const nonce = Buffer.from(
    hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0", "utf8"), 12),
  );

  const tag = ciphertext.subarray(ciphertext.length - 16);
  const decipher = createDecipheriv("aes-128-gcm", cek, nonce);
  decipher.setAuthTag(tag);
  const padded = Buffer.concat([
    decipher.update(ciphertext.subarray(0, ciphertext.length - 16)),
    decipher.final(),
  ]);
  return padded.subarray(0, padded.length - 1);
}

test("a random-key payload round-trips through a real client decrypt", () => {
  const client = createECDH("prime256v1");
  client.generateKeys();
  const authSecret = randomBytes(16);
  const subscription: PushSubscription = {
    endpoint: "https://push.example.net/xyz",
    keys: {
      p256dh: client.getPublicKey().toString("base64url"),
      auth: authSecret.toString("base64url"),
    },
  };
  const message = Buffer.from(JSON.stringify({ title: "hi", body: "there", url: "/" }), "utf8");
  const body = encryptPayload(message, subscription);
  const plaintext = decryptedForClient(
    body,
    client.getPrivateKey(),
    client.getPublicKey(),
    authSecret,
  );
  assert.deepEqual(plaintext, message);
});

test("VAPID keys validate and produce a verifiable ES256 token", () => {
  const keys = generateVapidKeys();
  assert.equal(isValidVapidPublicKey(keys.publicKey), true);
  assert.equal(isValidVapidPrivateKey(keys.privateKey), true);
  assert.notEqual(keys.publicKey, generateVapidKeys().publicKey);

  const now = new Date("2026-09-28T12:00:00Z");
  const header = vapidAuthorizationHeader("https://push.example.net/xyz", keys, "mailto:me@example.com", now);
  assert.equal(verifyVapidAuthorization(header, keys.publicKey), true);

  const jwt = /^vapid t=([^,]+),\s*k=/.exec(header)?.[1];
  assert.ok(jwt);
  const [headerSegment, payloadSegment, signatureSegment] = jwt.split(".");
  const decodedHeader = JSON.parse(b64urlDecode(headerSegment ?? "").toString("utf8"));
  const decodedPayload = JSON.parse(b64urlDecode(payloadSegment ?? "").toString("utf8"));
  assert.equal(decodedHeader.alg, "ES256");
  assert.equal(decodedPayload.aud, "https://push.example.net");
  assert.equal(decodedPayload.sub, "mailto:me@example.com");
  assert.ok(decodedPayload.exp > Math.floor(now.getTime() / 1000));
  assert.equal(b64urlDecode(signatureSegment ?? "").length, 64);

  const other = generateVapidKeys();
  const foreign = vapidAuthorizationHeader("https://push.example.net/xyz", other, "mailto:me@example.com", now);
  assert.equal(verifyVapidAuthorization(foreign, keys.publicKey), false);
});

test("invalid VAPID keys are rejected", () => {
  const keys = generateVapidKeys();
  assert.equal(isValidVapidPublicKey("not-a-key"), false);
  assert.equal(isValidVapidPublicKey(b64urlEncode(Buffer.alloc(65))), false);
  assert.equal(isValidVapidPrivateKey(keys.privateKey.slice(0, 10)), false);
});

test("a subscription with a malformed point is refused before encryption", () => {
  assert.throws(() =>
    encryptPayload(Buffer.from("x"), {
      endpoint: "https://push.example.net/abc",
      keys: { p256dh: b64urlEncode(Buffer.alloc(65, 1)), auth: b64urlEncode(randomBytes(16)) },
    }),
  );
});
