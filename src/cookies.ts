/**
 * The gateway's two cookies. Both use the `__Host-` prefix, which browsers
 * accept only with `Secure`, `Path=/` and no `Domain`, so no other host
 * (including a sibling subdomain) can set or shadow them.
 */

/** The login session: an opaque random id, stored server-side only as a hash. */
export const SESSION_COOKIE = "__Host-wt_session";
/** A short-lived pre-auth cookie naming the in-flight GitHub login attempt. */
export const LOGIN_COOKIE = "__Host-wt_login";

const MAX_COOKIE_HEADER = 8192;

/** Parse a Cookie header. The first occurrence of a name wins; malformed pairs are skipped. */
export function parseCookies(header: string | string[] | undefined): Map<string, string> {
  const cookies = new Map<string, string>();
  const raw = Array.isArray(header) ? header.join("; ") : header;
  if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_COOKIE_HEADER) return cookies;
  for (const part of raw.split(";")) {
    const separator = part.indexOf("=");
    if (separator <= 0) continue;
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (name.length === 0 || cookies.has(name)) continue;
    cookies.set(name, value);
  }
  return cookies;
}

export function serializeCookie(name: string, value: string, maxAgeSeconds: number): string {
  return `${name}=${value}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`;
}

export function clearCookie(name: string): string {
  return serializeCookie(name, "", 0);
}
