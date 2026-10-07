import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { PUBLIC_DIR } from "./helpers.js";

/**
 * The stylesheet parsed into the cascade's own terms: each rule is a selector
 * with its declarations under the media query (if any) that scopes it. The
 * layout contract is asserted on that model, never on source text.
 */
interface Rule {
  media: string | null;
  selector: string;
  decls: Map<string, string>;
}

function parseCss(source: string): Rule[] {
  const css = source.replace(/\/\*[\s\S]*?\*\//g, "");
  const rules: Rule[] = [];
  let pos = 0;

  function block(media: string | null, end: number): void {
    while (pos < end) {
      const open = css.indexOf("{", pos);
      const close = css.indexOf("}", pos);
      if (open === -1 || open > end || (close !== -1 && close < open)) {
        pos = close === -1 ? end : close + 1;
        return;
      }
      const prelude = css.slice(pos, open).trim();
      pos = open + 1;
      if (prelude.startsWith("@media")) {
        block(prelude.replace(/^@media\s*/, ""), end);
        continue;
      }
      const stop = css.indexOf("}", pos);
      const decls = new Map<string, string>();
      for (const part of css.slice(pos, stop).split(";")) {
        const colon = part.indexOf(":");
        if (colon === -1) continue;
        decls.set(part.slice(0, colon).trim(), part.slice(colon + 1).trim().replace(/\s+/g, " "));
      }
      for (const selector of prelude.split(",")) {
        rules.push({ media, selector: selector.trim().replace(/\s+/g, " "), decls });
      }
      pos = stop + 1;
    }
  }

  block(null, css.length);
  return rules;
}

const rules = parseCss(readFileSync(join(PUBLIC_DIR, "styles.css"), "utf8"));

const PHONE = null;
const WIDE = "(min-width: 720px)";
const LAPTOP = "(min-width: 1100px)";
const NARROW = "(max-width: 719px)";

/** The value the last matching rule in `media` sets for `prop` on `selector`. */
function value(media: string | null, selector: string, prop: string): string | undefined {
  let found: string | undefined;
  for (const rule of rules) {
    if (rule.media === media && rule.selector === selector && rule.decls.has(prop)) {
      found = rule.decls.get(prop);
    }
  }
  return found;
}

/** Media scopes in which `selector` sets `prop` to `expected`. */
function scopesSetting(selector: string, prop: string, expected: string): Array<string | null> {
  return rules
    .filter((rule) => rule.selector === selector && rule.decls.get(prop) === expected)
    .map((rule) => rule.media);
}

test("the stylesheet parser sees the breakpoints the layout depends on", () => {
  const scopes = new Set(rules.map((rule) => rule.media));
  for (const media of [PHONE, WIDE, LAPTOP, NARROW]) assert.ok(scopes.has(media), `missing ${media}`);
});

test("phone layout keeps the single 760px column and 16px gutter", () => {
  assert.equal(value(PHONE, "main", "max-width"), "760px");
  assert.equal(value(PHONE, ":root", "--gutter"), "16px");
  assert.equal(value(PHONE, ".conversation-empty", "display"), "none");
  assert.equal(value(PHONE, ".conversation-back", "display"), undefined);
});

test("opening a conversation hides the list only on phone widths", () => {
  assert.deepEqual(scopesSetting(".conversations.is-detail .conversation-list", "display", "none"), [NARROW]);
});

test("wide screens are fluid with list and conversation side by side", () => {
  assert.equal(value(WIDE, "main", "max-width"), "none");
  assert.match(value(WIDE, ":root", "--gutter") ?? "", /^clamp\(/);
  assert.equal(value(WIDE, ".conversations", "grid-template-columns"), "minmax(240px, 300px) minmax(0, 1fr)");
  assert.equal(value(WIDE, ".conversation-back", "display"), "none");
  // The pane fills the viewport height and only the transcript scrolls, so the
  // message box stays pinned to the bottom of the conversation pane.
  assert.equal(value(WIDE, ".conversation-detail:not([hidden])", "display"), "flex");
  assert.match(value(WIDE, ".conversation-detail:not([hidden])", "height") ?? "", /100dvh/);
  assert.equal(value(WIDE, ".conversation-detail .conversation-output", "flex"), "1 1 auto");
  assert.equal(value(WIDE, ".conversation-detail .conversation-output", "max-height"), "none");
  assert.equal(value(WIDE, ".conversation-detail .composer", "flex"), "none");
  // With nothing open, the empty state fills the detail column.
  assert.equal(value(WIDE, ".conversations:not(.is-detail) .conversation-empty", "display"), "grid");
  // Prose and forms keep a readable measure.
  assert.equal(value(WIDE, ".hint", "max-width"), "var(--measure)");
  assert.equal(value(PHONE, ":root", "--measure"), "72ch");
});

test("Status stacks its sections below laptop width and sets them side by side above it", () => {
  assert.equal(value(WIDE, "#status-body", "grid-template-columns"), "minmax(0, 1fr)");
  assert.match(value(LAPTOP, "#status-body", "grid-template-columns") ?? "", /^repeat\(auto-fit/);
});

test("laptop widths lay Status, Setup and Settings out in columns", () => {
  assert.equal(value(LAPTOP, "#status-body", "display"), "grid");
  assert.equal(value(LAPTOP, "#view-setup.is-active", "grid-template-columns"), "repeat(2, minmax(0, 1fr))");
  assert.equal(value(LAPTOP, "#view-settings.is-active", "grid-template-columns"), "repeat(2, minmax(0, 1fr))");
});
