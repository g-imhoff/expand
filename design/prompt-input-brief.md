# Design Brief — Reusable AI PromptInput component

- Status: design-complete, unapproved, UNCOMMITTED in worktree (do not commit; do not open a PR)
- Branch: `feat/prompt-input-component`
- Brief digest: `sha256:brief-v1` (recompute on edit: `sha256sum design/prompt-input-brief.md`)
- Candidate digest: `sha256:da8784924d235f81329f87d9a24e4973`
  (of `apps/desktop/src/renderer/features/chat/components/PromptInput.tsx`;
  ModelPicker `sha256:9b7776e0f8761ff6eb2356b6bcca7836`;
  provider-logos `sha256:56d795925fd77ff40fceb789d9e471e4`;
  prompt-mentions `sha256:5a4000910a7ae96f056569d205cc998c`;
  mention-segments `sha256:5f9bc6e08771023b45217edfea246ef5`)
- Iteration v3 (2026-09-22): applied shadcn preset `b27JBIHY`
  (`base-rhea`, green primary) — full token set added to the project
  `index.css`, send button now `bg-primary`, specimen imports the project
  stylesheet directly. Pushed after a transient Yodea auth outage; live bundle
  verified current (see section 8).
- Iteration v4: lightbox long-title overflow — first fix (title-only `min-w-0`)
  was insufficient because the dialog header is itself a grid item with auto
  min-width; fixed the whole chain (header `min-w-0`, title `truncate pr-6`)
  plus a regression tripwire in the lightbox test.
- Iteration v5: spacing fit to the preset — diffed the canonical `base-rhea`
  registry sources (`command`, `popover`, `dialog`, `dropdown-menu`). The new
  `rhea` generation uses `rounded-3xl`/animations/`base-ui` (not adopted: would
  churn shared primitives + add deps); aligned to classic shadcn control sizing
  instead: model trigger `h-9 text-sm px-3`, toolbar buttons/send `size-9`,
  toolbar inset unified `px-3 pb-3`, canonical Command root classes on the
  picker. Existing `ui/command|dialog|dropdown-menu` already match classic
  shadcn spacing and were left untouched.
- Iteration v6: provider headings — real OpenAI/Anthropic brand marks (fetched
  from the Simple Icons distribution, inlined as `currentColor` SVG so they
  follow both themes; unknown providers keep the initial-mark fallback),
  canonical `text-xs font-medium muted` heading style, `CommandSeparator`
  between provider groups (new export on the shared `ui/command` primitive).
  Bigger corners: composer shell, picker popover (with `overflow-hidden` so
  inner content respects the radius), and lightbox dialog now `rounded-xl`;
  dense menus/chips stay `rounded-md`.
- Iteration v7: `@folder` / `$skill` mentions — new `prompt-mentions`
  (tokenizer with offsets, caret trigger detection, probing filters) +
  `mention-segments` (backdrop pills: sky for folders, violet for skills).
  Composer textarea sits transparent over a layout-identical highlighted
  backdrop (caret kept visible, scroll synced); typing `@`/`$` opens a
  Folders/Skills listbox (arrows + Enter/Tab accept, Esc dismisses); accepted
  tokens insert `label + space`. Placeholder now advertises both triggers.
  Send payload gains `mentions[]` (`kind/key/start/end`). 4 new tests (14/14).
- Iteration v8: repo-gate compliance — knip-clean (dropped unused
  Portal/Anchor re-exports, option catalogs covered by tests), specimen moved
  to `examples/prompt-input-specimen/` so the pinned workspace-coverage
  architecture test passes; composer mounted on the homepage (`ProjectsView`
  “New conversation” section, local fixture state) so `dev:desktop` shows it.
  Package versions intentionally untouched (`0.0.0` sentinels enforced by the
  version-policy test). 16/16 component tests.

## 1. Objective

A reusable, production-intended `PromptInput` composer for future AI conversations in the
desktop renderer: text draft + static model picker + `+` options menu (sandbox, permissions,
thinking) + local image attachments. Props + callbacks only; no backend wiring.

## 2. Requirements (confirmed, do not re-ask)

- Standalone component under `apps/desktop/src/renderer`, new folder `features/chat/`.
- Props + callbacks; NO backend wiring.
- Model picker is a static configurable list via `models` prop + `onModelChange`.
- `+` button menu holds sandbox options, permissions, thinking controls as visual-only
  controlled state + callbacks, plus an add-image entry.
- Add-image uses a local file picker (`accept="image/*"`), thumbnail preview chips with
  remove buttons, `onImagesChange`, no upload.
- Enter = send, Shift+Enter = newline, send disabled when empty; `isLoading` prop.
- Reuse existing shadcn tokens/primitives; dark-mode aware; responsive.

## 3. Contract

```ts
interface PromptModelOption { id: string; label: string; provider: string; description?: string; disabled?: boolean }
interface PromptImageAttachment { id: string; name: string; url: string } // url = object URL or data URL
interface PromptSubmitPayload { text: string; modelId: string; images: ReadonlyArray<PromptImageAttachment> }
type SandboxMode = "off" | "workspace" | "full"
type PermissionMode = "ask" | "auto-approve" | "read-only"
type ThinkingLevel = "off" | "low" | "high"
```

`PromptInput` props: `models`, `selectedModelId`, `onModelChange`,
`favoriteModelIds`, `onFavoritesChange`, `images`, `onImagesChange`,
`onSend(payload)`, `sandbox`, `onSandboxChange`, `permission`, `onPermissionChange`, `thinking`,
`onThinkingChange`, `isLoading?`, `placeholder?`. Option lists exported as
`sandboxModeOptions`, `permissionOptions`, `thinkingOptions` for reuse by future settings UI.
`onSend` fires with the trimmed draft and clears it; the parent owns `images` and decides
whether to clear them after send.

## 4. Consequential decisions (and rejected directions)

1. Model picker is a dedicated **`ModelPicker` popover browser** (new
   `popover.tsx` primitive + existing `ui/command` wrappers + cmdk root): search
   field, one group per `provider`, per-row star toggle (`favoriteModelIds` +
   `onFavoritesChange`, parent-owned), favorites-first ordering within groups
   and favorite providers first. Rejected: separate Favorites group (row
   duplication) and native select (kept in v1, replaced per review: no search,
   no favorites, no grouping).
2. Image chips are **full-bleed thumbnail cards**: image fills the container
   (`object-cover`), filename reveals on hover/focus overlay, clicking opens a
   **`Dialog` lightbox** (existing primitive) with full-size `object-contain`
   image + filename title. Rejected: inline name caption (replaced per review).
   Touch users get the name via the preview button's accessible name and the
   lightbox title.
3. `+` menu unchanged (Radix dropdown, image entry + 3 radio families).
4. `PromptModelOption.provider` is **required**: uncategorized models cannot
   render in the grouped picker. All call sites updated (tests, specimen).
3. Images are **parent-owned** (`images` + `onImagesChange`); the component only creates preview
   object URLs via `URL.createObjectURL` and filters non-`image/*` picks. Attachment ids are
   deterministic (`name-size-lastModified-index`); no `Math.random`/`Date` (Effect lint bans them).
4. Send button uses `bg-foreground`/`text-background`: the project token set has no primary token;
   this pair contrasts in both themes. Spinner is a CSS ring with `motion-safe:animate-spin`.
5. Textarea auto-grows via `field-sizing-content` (progressive enhancement; falls back to a fixed
   3-row box). `role="status"` live region announces sending only (no focus theft).
6. Labels: visible placeholder + persistent sr-only `<label>`s (FORM-01/FORM-02); thumbnails are
   decorative (`alt=""`), chips named by filename; remove buttons named `Remove <name>`.

## 5. Responsive expectations

- Compact (320px): toolbar wraps (`flex-wrap`, `min-w-0`), select caps at `max-w-48`, image chips
  wrap; no page-level horizontal overflow (component evidence only, not a page claim).
- Intermediate (~768px): select keeps natural width (`sm:flex-none`), composer max width set by host.
- Wide (~1280px): unchanged single-column composer; host constrains line length.
- No orientation lock; DOM order matches visual order throughout.

## 6. Non-goals

Backend send/stop, uploads, persistence, streaming output, markdown rendering, prompt history,
token counting, auth, i18n, host-page integration, PR/commit.

## 7. Files (all new, uncommitted)

- `apps/desktop/src/renderer/components/ui/dropdown-menu.tsx` — shadcn-style primitive
  (Root/Trigger/Content/Item/Label/Separator/Group/RadioGroup/RadioItem).
- `apps/desktop/src/renderer/components/ui/popover.tsx` — shadcn-style primitive
  (Root/Trigger/Anchor/Content), same conventions.
- `apps/desktop/src/renderer/features/chat/components/PromptInput.tsx` — the candidate.
- `apps/desktop/src/renderer/features/chat/components/ModelPicker.tsx` — searchable,
  favoritable, provider-grouped model browser (popover + command + cmdk).
- `apps/desktop/test/ui/prompt-input.test.tsx` — 10 component tests (v1's 7, with the
  model-select test replaced: picker grouping + change, search filter, favorite toggle
  without selection change, image lightbox open/close).
- `examples/prompt-input-specimen/` — isolated Vite React TS specimen (synthetic SVG data-URL fixtures only),
  imports the real candidate + real renderer tokens.

## 8. Gate evidence (exact candidate, v4 2026-09-22 ~19:35 UTC)

- Preset source: `https://ui.shadcn.com/init?preset=b27JBIHY` → `base-rhea`,
  green primary (`oklch(0.527 0.154 150.069)` light / `oklch(0.448 0.119 151.328)`
  dark), radius `0.625rem`. Existing neutral tokens were byte-identical to the
  preset, so current UI is unchanged; the preset ADDS card/primary/secondary/
  destructive/input/chart/sidebar tokens. Geist font + `tw-animate-css` NOT
  applied (Next-template-only deps; no equivalent installed here).
- Format: N/A (no formatter in repo).
- Lint: `eslint` on the 4 touched app/test files — PASS.
- Typecheck: `tsc --noEmit -p tsconfig.workspace.json` — PASS, exit 0.
- Specimen typecheck + `vite build` — PASS (3 files).
- Tests: 10/10 PASS (incl. lightbox truncation tripwire).
- Preview: `yodea push --dir ./examples/prompt-input-specimen` → 3 files, 368551 bytes, live at `https://dev-guillaume-imhoff-prompt-input-specimen.ui.getyodea.com/`.
  Live bundle re-fetched with session auth: HTTP 200, asset names match local
  dist, served JS contains the `min-w-0` fix + `bg-primary`, served CSS contains
  the green primary tokens. An earlier `Forbidden` streak on push/list was a
  transient server-side outage (same saved token works before and after; no
  re-login was needed). Anonymous GET still 302s to team login (server policy).

## 9. Integration obligations for the next phase

- Render inside a host with a width constraint; verify 320px overflow in the real shell.
- Decide post-send image clearing (parent-side) and wire `onSend` to the real backend.
- If a global settings surface reuses `sandboxModeOptions`/`permissionOptions`/`thinkingOptions`,
  keep the labels/descriptions in sync with this file.
- Full-page a11y/contrast sign-off happens at integration, not from this isolated evidence.
