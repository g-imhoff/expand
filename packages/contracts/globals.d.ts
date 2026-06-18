// Baked into release binaries by `bun build --define '__YODEA_CHANNEL__="release"'`.
// Undefined when running from source (dev, tests, `bun apps/...`).
declare const __YODEA_CHANNEL__: "dev" | "release" | undefined
