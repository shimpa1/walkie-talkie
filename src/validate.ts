import { randomUUID } from "node:crypto";

/**
 * Mirrors firstmate's own `valid_request_id` contract in bin/fm-inbox.sh:
 * a non-empty token of at most 128 chars from [A-Za-z0-9._:-] that does not
 * start with a dot. Keeping the service's validation identical means a request
 * id that the service accepts can always be handed to firstmate unchanged.
 */
export function isValidRequestId(value: string): boolean {
  if (value.length === 0 || value.length > 128) return false;
  if (value.startsWith(".")) return false;
  return /^[A-Za-z0-9._:-]+$/.test(value);
}

export function newRequestId(): string {
  return randomUUID();
}

export const MAX_INSTRUCTION_BYTES = 32 * 1024;
