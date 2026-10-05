export const TOKEN_KEY = "walkie-talkie.token";
export const LEGACY_TOKEN_KEY = "reach.token";

export const UNAUTHORIZED_MESSAGE =
  "Unauthorized - your token is missing or wrong; set it in Settings";

export function normalizeToken(value) {
  if (typeof value !== "string") return "";
  return value.replace(/\s+/g, "");
}

function stripShellMarker(token) {
  return token.endsWith("%") ? token.slice(0, -1) : token;
}

export function tokenSuffix(value) {
  const token = normalizeToken(value);
  return token ? `...${token.slice(-4)}` : "";
}

export function readToken(storage) {
  try {
    const current = storage.getItem(TOKEN_KEY);
    if (current !== null) return normalizeToken(current);
    const legacy = storage.getItem(LEGACY_TOKEN_KEY);
    if (legacy === null) return "";
    storage.setItem(TOKEN_KEY, legacy);
    storage.removeItem(LEGACY_TOKEN_KEY);
    return normalizeToken(legacy);
  } catch {
    return "";
  }
}

export function resolveToken(storage, value) {
  const normalized = normalizeToken(value);
  const existing = readToken(storage);
  return normalized === existing ? existing : stripShellMarker(normalized);
}

export function writeToken(storage, value) {
  const token = resolveToken(storage, value);
  try {
    if (token) storage.setItem(TOKEN_KEY, token);
    else storage.removeItem(TOKEN_KEY);
  } catch {
    return token;
  }
  return token;
}

export function forgetToken(storage) {
  try {
    storage.removeItem(TOKEN_KEY);
  } catch {
    // A storage that refuses writes also has nothing to forget.
  }
}

export function authHeaders(token, extra) {
  const headers = Object.assign({}, extra || {});
  const bearer = normalizeToken(token);
  if (bearer) headers["authorization"] = `Bearer ${bearer}`;
  return headers;
}

/** Machine-readable gateway errors, shown as a sentence instead of the code. */
const ERROR_MESSAGES = {
  firstmate_not_provisioned: "Your firstmate is not running yet.",
  key_rejected: "The provider rejected this key. Check it and try again.",
  provider_unreachable: "Could not reach the provider to check the key; try again.",
  invalid_key_format: "That does not look like a key: 8 to 512 characters, no spaces.",
  key_required: "Save this provider's key first.",
  model_unavailable: "Your key cannot use that model; pick another.",
  unknown_credential: "That key is not on offer.",
  unknown_provider: "That provider is not on offer.",
  unknown_model: "That model is not on offer.",
  managed_by_config: "Your firstmate is set up by the admin in the configuration.",
  no_credential: "There is no saved key to remove.",
  busy: "Too many tries. Wait a minute and try again.",
};

export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

/**
 * Build the API client. On any 401 it reports through `onUnauthorized` and
 * throws an ApiError whose message tells the user to set the token in Settings,
 * so a missing or wrong token is never surfaced as a raw "unauthorized".
 */
export function createApi(options) {
  const opts = options || {};
  const fetchImpl = typeof opts.fetch === "function" ? opts.fetch : fetch;
  const getToken = typeof opts.getToken === "function" ? opts.getToken : () => "";
  const onUnauthorized = typeof opts.onUnauthorized === "function" ? opts.onUnauthorized : () => {};

  return async function api(path, init) {
    const requestInit = Object.assign({}, init || {});
    const token = getToken();
    requestInit.headers = authHeaders(token, requestInit.headers);
    const response = await fetchImpl(path, requestInit);
    const text = await response.text();
    let body = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    if (response.status === 401) {
      onUnauthorized(response, token);
      throw new ApiError(UNAUTHORIZED_MESSAGE, 401);
    }
    if (!response.ok) {
      const code = body && body.error ? body.error : null;
      const detail = code ? ERROR_MESSAGES[code] || code : `HTTP ${response.status}`;
      throw new ApiError(detail, response.status);
    }
    return body;
  };
}
