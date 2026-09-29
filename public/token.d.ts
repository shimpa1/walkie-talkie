export interface TokenStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export const TOKEN_KEY: string;
export const LEGACY_TOKEN_KEY: string;

export function loadToken(storage: TokenStorage): string;
