export const TOKEN_KEY: string;
export const LEGACY_TOKEN_KEY: string;

export const UNAUTHORIZED_MESSAGE: string;

export function normalizeToken(value: unknown): string;

export function tokenSuffix(value: unknown): string;

export interface TokenStorage {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem: (key: string) => void;
}

export function readToken(storage: TokenStorage): string;

export function writeToken(storage: TokenStorage, value: string): string;

export function forgetToken(storage: TokenStorage): void;

export function authHeaders(
  token: string,
  extra?: Record<string, string>,
): Record<string, string>;

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number);
}

export interface ApiResponseLike {
  ok: boolean;
  status: number;
  text: () => Promise<string>;
}

export interface CreateApiOptions {
  fetch?: (path: string, init?: RequestInit) => Promise<ApiResponseLike>;
  getToken?: () => string;
  onUnauthorized?: (response: ApiResponseLike, token: string) => void;
}

export function createApi(
  options?: CreateApiOptions,
): <T = unknown>(path: string, init?: RequestInit) => Promise<T>;
