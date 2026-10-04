import { createHash, randomBytes } from "node:crypto";

/**
 * GitHub OAuth App sign-in: authorization code with `state` and PKCE (S256).
 *
 * No scope is requested. A scopeless token can read the signed-in account's
 * public profile from `GET /user`, which is all sign-in needs: the immutable
 * numeric id and the current login. The access token is used for exactly that
 * one call and then dropped; it is never stored or logged.
 *
 * Every failure becomes an `OAuthError` with a fixed message. GitHub's response
 * bodies are never surfaced, so nothing they contain can reach a log line or a
 * browser.
 */

export interface GithubEndpoints {
  authorizeUrl: string;
  tokenUrl: string;
  apiUrl: string;
}

export const GITHUB_ENDPOINTS: GithubEndpoints = {
  authorizeUrl: "https://github.com/login/oauth/authorize",
  tokenUrl: "https://github.com/login/oauth/access_token",
  apiUrl: "https://api.github.com",
};

export interface GithubIdentity {
  id: number;
  login: string;
}

export interface GithubOAuthOptions {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  /** Overridden only by tests, which point it at a local fake GitHub. */
  endpoints?: GithubEndpoints;
  timeoutMs?: number;
}

export class OAuthError extends Error {
  override name = "OAuthError";
}

const DEFAULT_TIMEOUT_MS = 10_000;
/** GitHub logins: alphanumerics and single hyphens, at most 39 characters. */
const LOGIN_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

/** A PKCE verifier: 32 random bytes, base64url (43 characters). */
export function newCodeVerifier(): string {
  return randomBytes(32).toString("base64url");
}

export function codeChallenge(verifier: string): string {
  return createHash("sha256").update(verifier, "ascii").digest("base64url");
}

export class GithubOAuth {
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly redirectUri: string;
  private readonly endpoints: GithubEndpoints;
  private readonly timeoutMs: number;

  constructor(options: GithubOAuthOptions) {
    this.clientId = options.clientId;
    this.clientSecret = options.clientSecret;
    this.redirectUri = options.redirectUri;
    this.endpoints = options.endpoints ?? GITHUB_ENDPOINTS;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /** Where to send the browser to sign in. `allow_signup=false` hides GitHub sign-up. */
  authorizeUrl(state: string, verifier: string): string {
    const url = new URL(this.endpoints.authorizeUrl);
    url.searchParams.set("client_id", this.clientId);
    url.searchParams.set("redirect_uri", this.redirectUri);
    url.searchParams.set("state", state);
    url.searchParams.set("code_challenge", codeChallenge(verifier));
    url.searchParams.set("code_challenge_method", "S256");
    url.searchParams.set("allow_signup", "false");
    return url.toString();
  }

  /** Exchange an authorization code for the signed-in account's identity. */
  async identify(code: string, verifier: string): Promise<GithubIdentity> {
    const token = await this.exchange(code, verifier);
    return this.user(token);
  }

  private async exchange(code: string, verifier: string): Promise<string> {
    const body = new URLSearchParams({
      client_id: this.clientId,
      client_secret: this.clientSecret,
      code,
      redirect_uri: this.redirectUri,
      code_verifier: verifier,
    });
    const response = await this.request(this.endpoints.tokenUrl, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
    });
    if (!response.ok) throw new OAuthError("the GitHub token exchange failed");
    const json = await readJson(response);
    const token = json?.access_token;
    if (typeof token !== "string" || token.length === 0 || token.length > 1024) {
      // An error response (bad_verification_code, ...) carries no token.
      throw new OAuthError("GitHub did not issue a token");
    }
    return token;
  }

  private async user(token: string): Promise<GithubIdentity> {
    const response = await this.request(`${this.endpoints.apiUrl}/user`, {
      method: "GET",
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "user-agent": "walkie-talkie",
        "x-github-api-version": "2022-11-28",
      },
    });
    if (!response.ok) throw new OAuthError("the GitHub profile read failed");
    const json = await readJson(response);
    const id = json?.id;
    const login = json?.login;
    if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0) {
      throw new OAuthError("GitHub returned no account id");
    }
    if (typeof login !== "string" || !LOGIN_PATTERN.test(login)) {
      throw new OAuthError("GitHub returned no account login");
    }
    return { id, login };
  }

  private async request(url: string, init: RequestInit): Promise<Response> {
    try {
      return await fetch(url, {
        ...init,
        // A redirect is never followed: GitHub answers these calls directly.
        redirect: "manual",
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw new OAuthError("GitHub could not be reached");
    }
  }
}

async function readJson(response: Response): Promise<Record<string, unknown> | null> {
  try {
    const parsed = (await response.json()) as unknown;
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
