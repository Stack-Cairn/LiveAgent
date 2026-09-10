import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { cn } from "../../../agent-ui/src/lib/shared/utils.ts";
import { resolveStyleValues } from "../../../../scripts/test-style-values.mjs";

const require = createRequire(new URL("../../package.json", import.meta.url));
const postcss = require("postcss");
const tailwind = require("@tailwindcss/postcss");

test("native theme utilities retain the original dimensions without adding line heights", async () => {
  const result = await postcss([tailwind({ optimize: false })]).process(
    `@import "tailwindcss" source(none);
     @import "../../agent-ui/src/styles/tokens.css";
     @reference "../../agent-ui/src/styles/semantic-colors.css";
     @source inline("py-2 py-1px h-18px text-14px text-11p5px text-scaled-14px leading-scaled-22px pb-safe-bottom-10rem ring-3px status-compact:grid-cols-3");`,
    { from: new URL("../../src/style-theme-test.css", import.meta.url).pathname },
  );
  const root = postcss.parse(result.css);
  const properties = (selector) => {
    const values = new Map();
    root.walkRules(selector, (rule) => rule.walkDecls((d) => values.set(d.prop, d.value)));
    assert.ok(values.size, `${selector} should compile using only CSS configuration`);
    return values;
  };
  assert.equal(properties(".py-2").get("padding-block"), "calc(var(--spacing) * 2)");
  assert.equal(properties(".py-1px").get("padding-block"), "var(--spacing-1px)");
  assert.equal(properties(".h-18px").get("height"), "var(--spacing-18px)");
  assert.equal(properties(".text-14px").get("font-size"), "var(--text-14px)");
  assert.equal(properties(".text-14px").has("line-height"), false);
  assert.equal(properties(".text-11p5px").get("font-size"), "var(--text-11p5px)");
  assert.equal(
    properties(".text-scaled-14px").get("font-size"),
    "calc(var(--text-14px) * var(--zone-font-scale, 1))",
  );
  assert.equal(
    properties(".leading-scaled-22px").get("line-height"),
    "calc(var(--leading-22px) * var(--zone-font-scale, 1))",
  );
  assert.equal(
    resolveStyleValues(properties(".pb-safe-bottom-10rem").get("padding-bottom")),
    "calc(10rem + env(safe-area-inset-bottom))",
  );
  assert.match(properties(".ring-3px").get("--tw-ring-shadow"), /calc\(3px \+/);
  let compactMedia;
  root.walkRules(".status-compact\\:grid-cols-3", (rule) => {
    rule.walkAtRules("media", (media) => {
      compactMedia = media.params;
    });
  });
  assert.equal(compactMedia, "(max-width: 1400px), (max-height: 760px)");
});

test("named size, color and shadow utilities keep caller override behavior", () => {
  assert.equal(cn("text-sm text-red-500", "text-14px"), "text-red-500 text-14px");
  assert.equal(cn("text-14px", "text-sm"), "text-sm");
  assert.equal(cn("text-11p5px", "text-scaled-14px"), "text-scaled-14px");
  assert.equal(cn("py-2", "py-1px"), "py-1px");
  assert.equal(cn("max-w-panel-36rem", "max-w-80"), "max-w-80");
  assert.equal(cn("shadow-ui-composerattachmentcard-1", "shadow-lg"), "shadow-lg");
  assert.equal(
    cn("shadow-red-500", "shadow-ui-composerattachmentcard-1"),
    "shadow-red-500 shadow-ui-composerattachmentcard-1",
  );
  assert.equal(cn("ring-2", "ring-3px"), "ring-3px");
  assert.equal(cn("grid-cols-form-label", "grid-cols-2"), "grid-cols-2");
  assert.equal(cn("font-450", "font-medium"), "font-medium");
  assert.equal(cn("duration-220ms", "duration-200"), "duration-200");
  assert.equal(cn("animate-hub-loading-progress", "animate-spin"), "animate-spin");
  assert.equal(cn("animate-chat-hero-logo-enter", "animate-none"), "animate-none");
  assert.equal(cn("grid-rows-ssh-collapsible", "grid-rows-2"), "grid-rows-2");
  assert.equal(cn("shadow-login-container", "shadow-sm"), "shadow-sm");
  assert.equal(cn("shadow-red-500", "shadow-login-container"), "shadow-red-500 shadow-login-container");
  assert.equal(cn("drop-shadow-sync-loading-logo", "drop-shadow-none"), "drop-shadow-none");
  assert.equal(cn("ease-ui-enter", "ease-out"), "ease-out");
  assert.equal(cn("bg-red-500", "bg-trajectory-aborted"), "bg-red-500 bg-trajectory-aborted");
  assert.equal(cn("bg-trajectory-idle", "bg-none"), "bg-none");
  assert.equal(cn("underline-offset-3px", "underline-offset-4"), "underline-offset-4");
});

test("loading gradients and shadows coexist with colors and accept caller overrides", () => {
  assert.equal(cn("bg-red-500", "bg-skills-skeleton-shimmer"), "bg-red-500 bg-skills-skeleton-shimmer");
  assert.equal(cn("bg-hub-frost-hero", "bg-hub-frost-hero-dark"), "bg-hub-frost-hero-dark");
  assert.equal(cn("bg-hub-frost-hero", "bg-none"), "bg-none");
  assert.equal(cn("shadow-red-500", "shadow-hub-frost-hero"), "shadow-red-500 shadow-hub-frost-hero");
  assert.equal(cn("shadow-hub-frost-hero", "shadow-none"), "shadow-none");
});
