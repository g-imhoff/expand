# ESLint module ordering with semantics-preserving fixes

- **Date:** 2026-07-10
- **Status:** Approved (design) — pending implementation plan
- **Goal:** Enforce one predictable top-level declaration order across Expand's TypeScript files while ensuring `eslint --fix` never performs a reorder that may change runtime behavior.

## Problem

The enabled `local/exports-on-top` rule does not enforce the intended module
layout. It deliberately reports only non-exported type aliases and interfaces
that precede an export. It does not order imports, distinguish exported
classes/interfaces from other exports, or place non-exported runtime
declarations last.

A direct ESLint reproduction therefore accepts this shape:

```ts
import type { Effect } from "effect"

const privateBeforeExports = 1
export const exportedValue = privateBeforeExports
export interface ExportedShape {
  readonly effect: Effect.Effect<void>
}
```

Applying the desired four groups mechanically is unsafe. An exported initializer
may eagerly read a private `const`, and two otherwise independent top-level
initializers may have order-sensitive side effects. Moving either declaration
can introduce a temporal-dead-zone failure or change observable behavior.

The current tree has 56 ordering violations among 272 parsed TypeScript files.
The rule and migration therefore need an explicit safety model rather than an
unconditional text sort.

## Decision

Replace `local/exports-on-top` with a project-specific `local/module-order` rule.
It enforces the requested group order and offers an autofix only when the entire
candidate reorder is proven safe by conservative static constraints. When
safety cannot be established, the rule still reports the violation but provides
no fix; the declaration must be refactored manually.

This follows the principle that the layout order is strict while autofixing is
optional. `eslint --fix` must never guess about runtime semantics.

## Required group order

After any shebang or directive prologue, top-level statements have four ordered
groups:

1. **Imports.** All import declarations, including type-only and side-effect imports.
2. **Exported classes and interfaces.** Named/default, declared, and abstract forms are included.
3. **Other exports.** Exported types, enums, functions, variables, export lists, re-exports, and default expressions.
4. **Non-exported statements.** Private declarations and every other top-level statement.

Order within a group is stable: the rule does not alphabetize names or reorder
members that already belong to the same group. Existing import order is also
preserved.

## Classification

Classification is based on top-level ESTree statement shapes produced by the
configured TypeScript parser:

- `ImportDeclaration` and TypeScript import-equals declarations are imports.
- An `ExportNamedDeclaration` or `ExportDefaultDeclaration` whose declaration is
  a class or interface is an exported class/interface.
- Every other named/default export and every export-all declaration is another export.
- All remaining statements are non-exported.

An empty `export {}` module marker is non-exported because it exposes no symbol.
A declaration exported later through `export { name }` remains a private
declaration at its original location; the export list itself belongs to the
other-export group.

## Autofix safety model

The fixer treats each top-level statement and its attached comments as one
movable unit. It computes the preferred stable group order, then constrains that
order with edges that must not be crossed:

- Preserve the relative order of module-source requests so side-effect import
  and re-export evaluation cannot change.
- Preserve every resolved top-level binding dependency from a provider to an
  eager consumer.
- Preserve the relative order of statements whose initialization or evaluation
  may have side effects.
- Treat unknown syntax and ambiguous execution timing as effectful rather than
  assuming purity.
- Keep shebangs and directive prologues fixed at the beginning of the file.

The implementation uses a stable topological sort: group rank selects the next
available statement, and original source index breaks ties. A fix is offered
only if the constrained result fully satisfies the four-group order. If a
dependency or effect edge makes that impossible, the rule reports a dedicated
non-fixable diagnostic.

Obviously erased declarations such as interfaces and type aliases can move
freely. Function declarations and function-valued initializers may move only
when doing so does not cross an eager dependency or an effect barrier. Classes,
variable initializers, decorators, computed keys, static initialization,
top-level calls, and unfamiliar constructs are handled conservatively.

## Fix shape and comment preservation

The rule reports the first out-of-order statement. A fix replaces the smallest
contiguous top-level region needed for that safe reorder. ESLint's normal
multipass behavior handles any subsequent inversion.

Leading TSDoc and ordinary comments travel with the declaration they document.
File banners, section comments, directive comments, and trailing comments retain
their relative placement. If comment ownership is ambiguous, the region is not
autofixed.

The resulting output must be idempotent: linting and fixing an already-fixed
file produces no further text change.

## Rule files and configuration

- Replace `eslint-rules/exports-on-top.mjs` with
  `eslint-rules/module-order.mjs`.
- Replace the plugin export `exports-on-top` with `module-order` in
  `eslint-rules/index.mjs`.
- Replace `local/exports-on-top` with `local/module-order` in
  `eslint.config.mjs`.
- Keep the current ESLint file scope: `apps`, `packages`, and `examples`
  TypeScript/TSX files.

The rule remains local because the requested grouping includes variables and
arbitrary top-level statements that general sorting plugins intentionally do
not reorder.

## Diagnostics

The rule has two actionable messages:

- **Fixable order violation:** identifies the declaration's actual and expected group.
- **Unsafe order violation:** identifies the same mismatch and states that a runtime dependency, side effect, or ambiguous comment prevents an automatic fix.

Diagnostics point at the first misplaced statement so the file does not receive
a cascade of redundant errors.

## Tests

Add focused ESLint `RuleTester` coverage under
`test/eslint/module-order.test.mjs` and include that directory in Vitest's test
globs. Tests cover:

- every valid group and stable within-group order;
- imports after declarations;
- exported interfaces/classes after other exports;
- private declarations before exports;
- named/default declarations, export lists, re-exports, and `export {}`;
- safe dependency-aware fixes;
- eager private prerequisites that receive a diagnostic without an output fix;
- independent side-effectful initializers whose order is never changed;
- decorators, computed class keys, static initialization, and top-level calls;
- leading TSDoc, ordinary comments, banners, section comments, and trailing comments;
- directive prologues and shebangs;
- repeated-fix idempotence and parsing of the fixed output.

Tests are written before the implementation and must demonstrate the current
rule's missing behavior before the replacement is added.

## Repository migration

After enabling the rule:

1. Run `eslint . --fix` to migrate every provably safe violation.
2. Inspect the remaining non-fixable diagnostics individually.
3. Refactor private prerequisites without exporting implementation details or
   weakening the rule. Appropriate techniques include inlining a one-use value,
   moving initialization behind an existing lazy boundary, or reorganizing the
   exported declaration without changing its public contract.
4. Do not add blanket disables. A narrow disable is acceptable only when a
   documented runtime ordering constraint makes the four-group layout genuinely
   impossible and refactoring would change the API or semantics.

Existing user changes in the working tree must be preserved during migration.

## Verification

Completion requires fresh successful runs of:

- the focused RuleTester suite;
- `bun run lint` after migration;
- `bun run typecheck:all`;
- `bun run test`;
- `git diff --check`.

The migration diff must also be reviewed for comment attachment, public API
changes, and accidental edits outside top-level ordering.

## Non-goals

- Alphabetical sorting within any group.
- Sorting import specifiers, export specifiers, class members, object members, or
  function-local declarations.
- Automatically refactoring unsafe declarations into new runtime shapes.
- Exporting formerly private helpers merely to satisfy ordering.
- Disabling lint checks across a directory or file category.
- Adopting a broad third-party style guide.
