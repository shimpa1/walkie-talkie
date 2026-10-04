import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";

import { codeChallenge, GithubOAuth, newCodeVerifier, OAuthError } from "../src/github-oauth.js";

async function serve(handler: Parameters<typeof createServer>[1]): Promise<{ url: string; server: Server }> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no address");
  return { url: `http://127.0.0.1:${address.port}`, server };
}

function stop(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
}

function client(url: string, timeoutMs?: number): GithubOAuth {
  return new GithubOAuth({
    clientId: "Iv1.client",
    clientSecret: "the-client-secret",
    redirectUri: "https://walkie.example/auth/github/callback",
    endpoints: { authorizeUrl: `${url}/login/oauth/authorize`, tokenUrl: `${url}/login/oauth/access_token`, apiUrl: url },
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  });
}

test("the PKCE challenge matches the RFC 7636 test vector", () => {
  assert.equal(
    codeChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
    "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
  );
  const verifier = newCodeVerifier();
  assert.match(verifier, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(newCodeVerifier(), verifier);
});

test("the authorize URL carries the client, callback, state and S256 challenge, and asks for no scope", () => {
  const url = new URL(client("https://github.example").authorizeUrl("st4te", "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"));
  assert.equal(url.origin + url.pathname, "https://github.example/login/oauth/authorize");
  assert.deepEqual(Object.fromEntries(url.searchParams), {
    client_id: "Iv1.client",
    redirect_uri: "https://walkie.example/auth/github/callback",
    state: "st4te",
    code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    code_challenge_method: "S256",
    allow_signup: "false",
  });
});

test("identify exchanges the code with the verifier and reads the numeric id and login", async () => {
  const seen: { form?: URLSearchParams; auth?: string; ua?: string } = {};
  const { url, server } = await serve((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      if (req.url === "/login/oauth/access_token") {
        seen.form = new URLSearchParams(Buffer.concat(chunks).toString());
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ access_token: "gho_token", token_type: "bearer" }));
        return;
      }
      seen.auth = req.headers.authorization;
      seen.ua = req.headers["user-agent"];
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: 20532068, login: "shimpa1" }));
    });
  });
  try {
    assert.deepEqual(await client(url).identify("the-code", "the-verifier"), { id: 20532068, login: "shimpa1" });
    assert.equal(seen.form?.get("code"), "the-code");
    assert.equal(seen.form?.get("code_verifier"), "the-verifier");
    assert.equal(seen.form?.get("client_secret"), "the-client-secret");
    assert.equal(seen.form?.get("redirect_uri"), "https://walkie.example/auth/github/callback");
    assert.equal(seen.auth, "Bearer gho_token");
    assert.equal(seen.ua, "walkie-talkie");
  } finally {
    await stop(server);
  }
});

test("every GitHub failure is a fixed OAuthError that carries none of GitHub's text", async () => {
  const cases: Array<{ name: string; token: (res: import("node:http").ServerResponse) => void; user?: (res: import("node:http").ServerResponse) => void }> = [
    {
      name: "error body",
      token: (res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "bad_verification_code", error_description: "SECRET-ECHO" }));
      },
    },
    { name: "server error", token: (res) => { res.writeHead(500); res.end("SECRET-ECHO"); } },
    { name: "redirect", token: (res) => { res.writeHead(302, { location: "https://elsewhere.example/" }); res.end(); } },
    { name: "not json", token: (res) => { res.writeHead(200); res.end("SECRET-ECHO"); } },
    {
      name: "bad profile",
      token: (res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ access_token: "gho_x" }));
      },
      user: (res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ id: "20532068", login: "SECRET-ECHO; rm -rf" }));
      },
    },
    {
      name: "profile refused",
      token: (res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ access_token: "gho_x" }));
      },
      user: (res) => { res.writeHead(401); res.end("SECRET-ECHO"); },
    },
  ];
  for (const scenario of cases) {
    const { url, server } = await serve((req, res) => {
      req.resume();
      req.on("end", () => (req.url === "/user" && scenario.user ? scenario.user(res) : scenario.token(res)));
    });
    try {
      await assert.rejects(client(url).identify("c", "v"), (error: unknown) => {
        assert.ok(error instanceof OAuthError, scenario.name);
        assert.ok(!error.message.includes("SECRET-ECHO"), `${scenario.name}: GitHub text leaked`);
        return true;
      });
    } finally {
      await stop(server);
    }
  }
});

test("an unreachable or hung GitHub fails the sign-in instead of hanging it", async () => {
  await assert.rejects(client("http://127.0.0.1:1").identify("c", "v"), OAuthError);
  const { url, server } = await serve(() => {
    // Never answer.
  });
  try {
    await assert.rejects(client(url, 100).identify("c", "v"), /could not be reached/);
  } finally {
    await stop(server);
  }
});
