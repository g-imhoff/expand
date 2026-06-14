# How `ink-input` works

`ink-input` is the **input plumbing** for the Ink (React-for-terminal) TUI; the
`apps/tui` files are the consumer that supplies the policy. Here's the full
mechanism, end to end.

## The one pipeline

Every keystroke flows through exactly one path, declared at the top of `app.tsx`:

```
useKeyRouter → route (pure) → uiReduce (pure) → setUi + runEffect
```

`ink-input` owns the first link and the pure helpers (`toKeyName`,
`resolveBinding`, `textFieldConsumes/Reduce`); `apps/tui` owns `route`, the
binding tables, and `uiReduce`.

## Step 1 — Capture: the single `useInput` (`use-key-router-ink.tsx`)

Ink's `useInput` is a **global broadcast** — every mounted component that calls
it receives *every* key. That makes exclusive routing impossible if more than
one handler exists. So the package exposes exactly one wrapper, `useKeyRouter`,
and an architecture test (`tui-input-boundary.test.ts`) pins it as the only
`useInput` call in the repo. `app.tsx` calls it once; no other component
registers input — note `TextField` is explicitly "render-only, registers NO
input handler."

When Ink fires, the callback gets Ink's raw `(input, key)` and immediately calls
`toKeyName(input, key)`.

## Step 2 — Normalize: `key-name.ts`

`toKeyName` collapses all terminal quirks into one canonical `KeyName` string —
`"up"`, `"return"`, `"ctrl+x"`, a literal `"a"`, etc. This is *the only place*
terminal weirdness is handled. Everything downstream is pure string logic, so
it's unit-testable without a terminal. `InkKey` mirrors Ink's `Key` shape
structurally so Ink's object passes straight through without `ink` ever being
imported here.

The callback forwards `(keyName, input)` to the consumer's `route`.

## Step 3 — Route: `apps/tui/input/route.ts` using `resolveBinding` + `textFieldConsumes`

This is **the routing decision**: top-down, first match returns and stops, so a
key can never reach two consumers. There are three contexts, checked in priority
order:

1. **Overlay open** (modal) → only that overlay's binding table is consulted.
2. **Create field focused** → only `createBindings`. Structurally, *no command
   lookup exists in this branch* — typing `d` cannot trigger "delete".
3. **List focused** → `listBindings`, enriched with the selected project.

Two `ink-input` primitives do the work:

- **`resolveBinding(table, keyName)`** (`bindings.ts`) — walks the binding array,
  returns the action of the first binding whose `keys` include this key, else
  `null`. First-match-wins enforces "a key can never resolve to two actions."

- **`textFieldConsumes(keyName, input)`** (`text-field.ts`) — the crucial "does
  the text field claim this key?" gate. This is where the **paste-vs-keypress
  ambiguity** is solved. A real Enter arrives as `keyName "return"` with
  `input ""`; a *pasted* literal word "return" arrives as `keyName "return"`
  with `input "return"`. The rule: `input.length > 0 && keyName === input` ⇒
  it's printable text (claim it as a `TextKey` action). Real special keys never
  have `input` equal to their own name, so they fall through to the binding
  table (submit/cancel/etc.). That's why `route.ts` gives the text field "first
  refusal" before consulting the overlay table.

`route` returns a single `Action` (a tagged union) or `null` (ignore the key).

## Step 4 — Reduce: `apps/tui/input/reduce.ts` using `textFieldReduce`

`uiReduce(ui, action)` is a pure `(state, action) → { ui, effects }` function.
Two kinds of outcomes:

- **UI-only transitions** (open overlay, switch focus, move selection) → new
  `UiState`, no effects.
- **`TextKey` actions** → calls **`textFieldReduce`** (`ink-input`) on whichever
  field is active (`create`, rename/directory `field`, or metadata
  `description`/`tags`). `textFieldReduce` appends printable input or, on
  backspace/delete, removes the last *code point* (`[...value].slice(0,-1)` —
  avoids splitting surrogate pairs/emoji). This is the generic text-edit
  semantics, written once, reused by every field.
- **Domain actions** (submit/archive/delete) → emit descriptive **effects**
  (data), e.g. `{ _tag: "Create", name }`. Effects are just data here; they
  don't touch the backend.

## Step 5 — Apply: back in `app.tsx`

`setUi(result.ui)` re-renders, and
`for (const effect of result.effects) runEffect(effect)` is the *only* place
effects meet the real backend (`useProjects`). React re-renders the tree from
the new `ui`; `TextField` shows `state.value` — so the character you typed
appears.

## The binding tables do double duty (`apps/tui/input/bindings.ts` + `hint-bar-ink.tsx`)

This is the package's headline guarantee. The *same* `Binding[]` arrays are
consumed by:

- `route.ts` via `resolveBinding` → what keys actually *fire*, and
- `<HintBar bindings={activeBindings(ui)} />` → what the help line *shows*
  (`hint-bar-ink.tsx` just maps each binding to `` `${keys[0]} ${label}` ``).

`activeBindings(ui)` returns the table for the current context, exactly matching
the branch `route` will take. So **the visible help can never drift from
fireable behavior** — they're literally the same data.

## Worked example — typing in the rename overlay, then pressing Enter

1. You press `x` with rename open. `toKeyName → "x"`, input `"x"`.
2. `route`: overlay is `rename` → `textFieldConsumes("x","x")` is true
   (`input===keyName`) → returns `{ _tag: "TextKey", keyName:"x", input:"x" }`.
3. `uiReduce` → `editActiveField` → `textFieldReduce` appends `"x"` to
   `overlay.field`. Re-render shows it.
4. You press Enter. `toKeyName → "return"`, input `""`.
5. `route`: `textFieldConsumes("return","")` is **false** (input empty) → falls
   through to `resolveBinding(textOverlayBindings,"return")` →
   `{ _tag: "SubmitOverlay" }`.
6. `uiReduce` → `submitOverlay` → closes overlay, emits
   `{ _tag:"Rename", id, name }`.
7. `app.tsx` `runEffect` calls `rename(id, name)` on the backend.

## Summary of the boundary

`ink-input` is deliberately split:

- **Pure, never imports `ink`:** `key-name.ts`, `bindings.ts`, `text-field.ts` —
  all the *logic*, fully unit-testable.
- **Thin `ink` adapters:** `use-key-router-ink.tsx` (the one input source) and
  `hint-bar-ink.tsx` (render-only).

It contains zero app policy — no key→action mappings, no state shape. Those live
in `apps/tui`. The package just provides: one exclusive capture point, key
normalization, first-match binding resolution, and reusable text-field
semantics — arranged so help always equals behavior and all decisions stay in
testable pure functions.
