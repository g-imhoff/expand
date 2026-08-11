# Agent instructions

## Code comments

- Do not write code comments unless the user explicitly asks for them. If a comment would be genuinely valuable at one specific place, propose it and ask — never add it unprompted.
- When asked, doc comments are TSDoc (`/** … */`) and must stay TypeDoc-compatible: no docgen pipeline exists yet (deliberate — adopt TypeDoc + typedoc-plugin-markdown emitting into `docs/api/` if one is ever added). Shape: one-line summary first (that's the LSP hover), contract in `@remarks`, `@param name - description` in signature order, `@returns`, `@defaultValue` on defaulted options, `{@link}` cross-references, titled `@example` with ```ts fences. House-style reference: `apps/server/db/event-store.ts`.
