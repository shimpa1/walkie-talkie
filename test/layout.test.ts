import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { PUBLIC_DIR } from "./helpers.js";

const css = readFileSync(join(PUBLIC_DIR, "styles.css"), "utf8");
const html = readFileSync(join(PUBLIC_DIR, "index.html"), "utf8");

/** The body of the first `@media (<query>) { ... }` block, brace-matched. */
function mediaBlock(query: string): string {
  const start = css.indexOf(`@media (${query}) {`);
  assert.notEqual(start, -1, `missing @media (${query})`);
  let depth = 0;
  for (let i = css.indexOf("{", start); i < css.length; i++) {
    if (css[i] === "{") depth++;
    if (css[i] === "}" && --depth === 0) return css.slice(start, i + 1);
  }
  throw new Error(`unterminated @media (${query})`);
}

function outsideMedia(): string {
  let out = css;
  for (const query of ["min-width: 720px", "min-width: 1100px", "max-width: 719px"]) {
    out = out.replace(mediaBlock(query), "");
  }
  return out;
}

test("phone layout keeps the single 760px column and 16px gutter", () => {
  const base = outsideMedia();
  assert.match(base, /main \{[^}]*max-width: 760px;/);
  assert.match(base, /--gutter: 16px;/);
  assert.match(base, /\.conversation-empty \{\s*display: none;/);
});

test("opening a conversation hides the list only below the wide breakpoint", () => {
  const hideRule = /\.conversations\.is-detail \.conversation-list \{\s*display: none;/;
  assert.match(mediaBlock("max-width: 719px"), hideRule);
  assert.doesNotMatch(outsideMedia(), hideRule);
  assert.doesNotMatch(mediaBlock("min-width: 720px"), hideRule);
  assert.doesNotMatch(mediaBlock("min-width: 1100px"), hideRule);
});

test("wide screens are fluid with list and conversation side by side", () => {
  const wide = mediaBlock("min-width: 720px");
  assert.match(wide, /main \{\s*max-width: 1920px;/);
  assert.match(wide, /\.conversations \{\s*grid-template-columns: minmax\(240px, 300px\) minmax\(0, 1fr\);/);
  assert.match(wide, /\.conversation-back \{\s*display: none;/);
  // The pane fills the viewport and only the transcript scrolls, so the
  // message box stays pinned to the bottom of the conversation pane.
  assert.match(wide, /\.conversation-detail:not\(\[hidden\]\) \{[^}]*display: flex;[^}]*height: calc\(100dvh/);
  assert.match(wide, /\.conversation-detail \.conversation-output \{[^}]*flex: 1 1 auto;/);
  // With nothing open, the empty state fills the detail column.
  assert.match(wide, /\.conversations:not\(\.is-detail\) \.conversation-empty \{\s*display: grid;/);
  // Prose and forms stay at a readable measure.
  assert.match(wide, /\.hint,[^{]*\{\s*max-width: var\(--measure\);/);
});

test("the conversation empty state sits between the list and the detail pane", () => {
  const list = html.indexOf('class="conversation-list"');
  const empty = html.indexOf('id="conversation-empty"');
  const detail = html.indexOf('id="conversation-detail"');
  assert.ok(list !== -1 && list < empty && empty < detail);
});
