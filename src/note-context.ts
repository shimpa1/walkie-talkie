import { isValidPaneId } from "./herdr.js";

/**
 * Where a note was written from: a follow-up inside an instruction thread, or a
 * note written while reading a live session. The note still goes to firstmate
 * only; the context just tells firstmate which conversation the captain meant.
 */
export interface NoteContext {
  kind: "thread" | "session";
  id: string;
  label: string;
}

export const MAX_CONTEXT_LABEL_LENGTH = 120;

/**
 * The first line of a note that carries context. The app parses it back out of
 * the receipts to group follow-ups under their thread, so the shape is fixed:
 * `[walkie-talkie] <phrase> <id>` plus an optional JSON-quoted label.
 */
export const CONTEXT_HEADER_PREFIX = "[walkie-talkie]";
const THREAD_PHRASE = "Follow-up in conversation";
const SESSION_PHRASE = "Sent while viewing live session";

/** Mirrors firstmate's own `valid_note_id` in bin/fm-inbox.sh. */
export function isValidNoteId(value: string): boolean {
  if (value.length === 0 || value.length > 128) return false;
  if (value.includes("..")) return false;
  return /^[A-Za-z0-9._-]+$/.test(value);
}

/** A single display line: control and line-separator characters become spaces. */
function cleanLabel(value: string): string {
  const flat = value.replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, " ").replace(/\s+/g, " ").trim();
  if (flat.length <= MAX_CONTEXT_LABEL_LENGTH) return flat;
  return `${flat.slice(0, MAX_CONTEXT_LABEL_LENGTH - 1)}…`;
}

/** Validate the optional `context` field of a note request. */
export function parseNoteContext(value: unknown): NoteContext | null | { error: string } {
  if (value === undefined || value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) {
    return { error: "'context' must be an object" };
  }
  const record = value as Record<string, unknown>;
  const kind = record.kind;
  if (kind !== "thread" && kind !== "session") {
    return { error: "'context.kind' must be 'thread' or 'session'" };
  }
  const id = record.id;
  if (typeof id !== "string") return { error: "'context.id' must be a string" };
  if (kind === "thread" ? !isValidNoteId(id) : !isValidPaneId(id)) {
    return { error: `'context.id' is not a valid ${kind} id` };
  }
  const label = record.label;
  if (label !== undefined && typeof label !== "string") {
    return { error: "'context.label' must be a string" };
  }
  return { kind, id, label: label === undefined ? "" : cleanLabel(label) };
}

/** The note body firstmate receives: a context header line, a blank line, then the text. */
export function composeNoteText(text: string, context: NoteContext | null): string {
  const body = text.startsWith(CONTEXT_HEADER_PREFIX) ? `\\${text}` : text;
  if (context === null) return body;
  const phrase = context.kind === "thread" ? THREAD_PHRASE : SESSION_PHRASE;
  const label = context.label ? ` ${JSON.stringify(context.label)}` : "";
  return `${CONTEXT_HEADER_PREFIX} ${phrase} ${context.id}${label}\n\n${body}`;
}
