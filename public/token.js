export const TOKEN_KEY = "walkie-talkie.token";
export const LEGACY_TOKEN_KEY = "reach.token";

export function loadToken(storage) {
  const current = storage.getItem(TOKEN_KEY);
  if (current !== null) return current;
  const legacy = storage.getItem(LEGACY_TOKEN_KEY);
  if (legacy === null) return "";
  storage.setItem(TOKEN_KEY, legacy);
  storage.removeItem(LEGACY_TOKEN_KEY);
  return legacy;
}
