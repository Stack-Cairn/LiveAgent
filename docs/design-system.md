# Design system

The desktop frontend (`crates/agent-gui`) and the Gateway WebUI
(`crates/agent-gateway/web`) render the same shared UI from `crates/agent-ui`.
Both import `crates/agent-ui/src/styles/base.css`, so there is one set of
tokens and one set of primitives. This page lists them and the rules that keep
new code on them.

## Where tokens live

| File | Contents |
| --- | --- |
| `crates/agent-ui/src/styles/tokens.css` | `@theme` scales (spacing, text, radius, shadow) and the light (`:root`) and dark (`.dark`) values of every semantic color, overlay and layer variable |
| `crates/agent-ui/src/styles/semantic-colors.css` | `@theme inline` mappings that turn the variables into Tailwind colors (`bg-warning`, `text-info`, `bg-overlay`) |
| `crates/agent-ui/src/styles/base.css` | `zone-font-scale` overrides of the text sizes and the `layer-*` z-index utilities |
| `crates/agent-ui/src/lib/shared/style-token-names.generated.json` | custom token names for `cn()` (tailwind-merge); `style-token-contract.test.mjs` keeps it in sync with `tokens.css` |

These are the only files that may define raw colors. Everything else uses the
utilities below; `pnpm check:design-tokens` enforces it (see Guardrail).

## Color roles

Every role has a light and a dark value. A role is used at full strength for
text and icons, with an opacity for tints, borders and rings, and with its
`-foreground` for text on a solid fill.

| Role | Utilities | Use for |
| --- | --- | --- |
| Surface | `bg-background`, `bg-card`, `bg-popover`, `bg-muted`, `bg-surface-subtle` | page, raised card, floating surface, quiet fill, very faint row or well tint |
| Text | `text-foreground`, `text-muted-foreground`, `text-card-foreground`, `text-popover-foreground` | body copy, secondary copy |
| Border | `border-border`, `border-input`, `divide-border` | hairlines, field borders |
| Accent | `bg-accent text-accent-foreground` | hover and selected rows |
| Primary | `bg-primary text-primary-foreground`, `text-primary` | primary actions, active state |
| Focus | `ring-ring`, `outline-ring` | focus rings |
| Success | `text-success`, `bg-success/10`, `border-success/25`, `bg-success text-success-foreground` | completed, connected, saved, added lines |
| Warning | `text-warning`, `bg-warning/10`, `border-warning/25`, `bg-warning text-warning-foreground` | needs attention, pending review, risky option |
| Info | `text-info`, `bg-info/10`, `border-info/25`, `bg-info text-info-foreground` | neutral notices, running, links to more detail |
| Danger | `text-destructive`, `bg-destructive/10`, `border-destructive/25`, `bg-destructive text-destructive-foreground` | errors, failed, delete, removed lines |
| Overlay | `bg-overlay` | the scrim behind dialogs, sheets and the command palette |

Status roles use the 700 shade in light mode and the 300 shade in dark mode,
so text and icons keep readable contrast on both themes without a `dark:`
override. Do not add `dark:text-*` next to a role utility; the role already
switches. A typical chip, notice or banner is:

```tsx
<div className="rounded-lg border border-warning/25 bg-warning/10 px-3 py-2 text-xs text-warning">
```

Raw Tailwind palette colors (`text-amber-700`, `bg-emerald-500/10`) are for
categorical data only: chart series, mention chip kinds, trajectory record
kinds, user-picked drawing and calendar colors, branch lanes. If the color
means "ok", "careful", "for your information" or "failed", use the role.

## Scales

| Scale | Tokens | Notes |
| --- | --- | --- |
| Font size | `text-tiny` (10px), `text-2xs` (11px), `text-xs` ... `text-5xl` | all scale with `zone-font-scale`; `text-tiny` is for counts, key caps and compact badges, `text-2xs` for dense metadata |
| Font weight | `font-normal`, `font-book` (450), `font-medium`, `font-semibold` | `font-book` is the transcript body weight |
| Radius | `rounded-xs` (4px), `rounded-sm` (6px), `rounded-md` (8px), `rounded-lg` (10px), `rounded-xl` (14px), `rounded-2xl` (18px), `rounded-3xl` (22px), `rounded-full` | derived from `--radius`; use these instead of `rounded-Npx` |
| Shadow | `shadow-card`, `shadow-popover`, `shadow-dialog` | raised card, menus and popovers, dialogs and the palette |
| Layers | `layer-raised`, `layer-panel`, `layer-popover`, `layer-modal`, `layer-toast`, `layer-critical` | for anything that escapes its parent; plain `z-10` is fine for stacking inside one component |
| Dense rows | `px-row-x`, `py-row-y`, `py-row-y-dense` | menu items, list rows and palette results |

## Primitives

All live in `crates/agent-ui/src/components/ui/` unless noted. Reach for these
before writing a class string by hand.

| Primitive | Use for |
| --- | --- |
| `Button` | every clickable action; variants `default`, `secondary`, `outline`, `ghost`, `destructive`, `link` |
| `IconButton` | icon-only actions. Requires `label`, which becomes `aria-label` and (unless `nativeTitle={false}`, e.g. inside a `ShortcutTooltip`) the tooltip. `tone="destructive"` for delete. Ghost, `rounded-lg`, muted icon that turns `foreground` on hover |
| `Badge` | status chips and counts; variants `default`, `secondary`, `outline`, `muted`, `success`, `warning`, `info`, `destructive`; `size="compact"` for dense rows |
| `StatusDot` | the small state dot next to a label; `tone` success, warning, info, destructive, primary, muted; `size` sm or md; `pulse` while something is in progress |
| `SectionHeader` | small uppercase group labels above a list or form section (`size="tiny"` or `"xs"`, `render` to change the element) |
| `EmptyState` | layout for empty lists and panels (`variant="workspace"` for panes, `"settings"` for settings tiles, `size="compact"`); the caller supplies icon, copy and action |
| `SettingsToggleGroup` (`components/settings/`) | segmented control for two to five exclusive options |
| `SettingsSection`, `SettingsCard`, `SettingsRow` (`components/settings/SettingsLayout.tsx`) | settings pages: titled section, card container, label/control row |
| `SettingsNotice` (`components/settings/`) | inline notices in settings (`warning`, `installation-warning`, `inline-error`) |
| `Dialog` + `DialogHeader`, `DialogBody`, `DialogSectionHeader`, `DialogFooter` | modal dialogs (scrim `bg-overlay`, `shadow-dialog`) |
| `Command*` | the command palette and searchable pickers |
| `DropdownMenu*`, `ContextMenu*`, `Popover`, `menu-surface.ts` | menus and popovers (`shadow-popover`, dense row spacing) |
| `CopyButton`, `Kbd`, `Skeleton`, `Meter`, `Switch`, `Tabs`, `Tooltip` | as named |

## Guardrail

`scripts/check-design-tokens.mjs` (`pnpm check:design-tokens`, CI Code Rules)
scans tracked `.ts`, `.tsx` and `.css` files under the three `src/` roots,
excluding tests, `.d.ts`, generated files, the token files and the brand logos
in `components/IconSet.tsx`. Comments are ignored. It counts four kinds of
hard-coded styles:

- `color-literal`: hex, `rgb()`, `hsl()`, `oklch()` values
- `palette-color`: raw Tailwind palette utilities, black and white included
- `arbitrary-color`: arbitrary color values such as `bg-[#2168d5]` or `text-[hsl(var(--x))]`
- `arbitrary-size`: arbitrary font size, weight, radius, shadow, z-index or spacing such as `text-[11px]`, `rounded-[10px]`, `z-[60]`

Files that already had such styles are recorded per rule in
`scripts/budgets/design-token-baseline.json`. A new file must have none and a
listed count must not grow. When a file gets cleaner the check fails until the
lower count is recorded:

```sh
pnpm check:design-tokens
pnpm check:design-tokens --update   # lowers counts / drops entries; never adds or raises
pnpm check:design-tokens --report   # totals per rule
```

If a raw color is really data (a chart series, a user-picked color), keep it
in one module next to the feature. Adding a baseline entry or raising a count
is a manual edit of the JSON file and needs a justification in review.
