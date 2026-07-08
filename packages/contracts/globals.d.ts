// Baked into release binaries by `bun build --define '__EXPAND_CHANNEL__="release"'`.
// Undefined when running from source (dev, tests, `bun apps/...`).
declare const __EXPAND_CHANNEL__: "dev" | "release" | undefined
