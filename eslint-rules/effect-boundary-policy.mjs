export const nativePromiseStatics = Object.freeze([
  "all",
  "allSettled",
  "any",
  "race",
  "reject",
  "resolve",
  "try",
  "withResolvers"
])

export const promiseChainMethods = Object.freeze(["catch", "finally", "then"])

export const effectRunnerMethods = Object.freeze([
  "runCallback",
  "runFork",
  "runPromise",
  "runPromiseExit",
  "runSync",
  "runSyncExit"
])

export const runtimeRunnerMethods = Object.freeze([
  "runCallback",
  "runFork",
  "runPromise",
  "runPromiseExit",
  "runSync",
  "runSyncExit"
])

export const nodeRuntimeRunnerMethods = Object.freeze(["runMain"])

export const effectCallbackMethods = Object.freeze([
  "acquireRelease",
  "acquireUseRelease",
  "andThen",
  "async",
  "callback",
  "catch",
  "catchAll",
  "catchIf",
  "catchTag",
  "catchTags",
  "filter",
  "filterMap",
  "flatMap",
  "fn",
  "fnUntraced",
  "forEach",
  "gen",
  "iterate",
  "loop",
  "map",
  "match",
  "matchEffect",
  "onError",
  "onExit",
  "suspend",
  "sync",
  "tap",
  "tapBoth",
  "tapError",
  "tapErrorCause",
  "try",
  "tryPromise",
  "unless",
  "validate",
  "when"
])

export const effectFunctionMethods = Object.freeze(["fn", "fnUntraced"])

export const schemaSyncMethods = Object.freeze([
  "decodeSync",
  "decodeUnknownSync",
  "encodeSync",
  "validateSync"
])

export const deterministicNodeUrlExports = Object.freeze([
  "URL",
  "URLSearchParams"
])

export const nodeBuiltinModules = Object.freeze([
  "assert",
  "assert/strict",
  "async_hooks",
  "buffer",
  "child_process",
  "cluster",
  "console",
  "constants",
  "crypto",
  "dgram",
  "diagnostics_channel",
  "dns",
  "dns/promises",
  "domain",
  "events",
  "fs",
  "fs/promises",
  "http",
  "http2",
  "https",
  "inspector",
  "module",
  "net",
  "os",
  "path",
  "path/posix",
  "path/win32",
  "perf_hooks",
  "process",
  "punycode",
  "querystring",
  "readline",
  "readline/promises",
  "repl",
  "stream",
  "stream/consumers",
  "stream/promises",
  "stream/web",
  "string_decoder",
  "sys",
  "test",
  "timers",
  "timers/promises",
  "tls",
  "trace_events",
  "tty",
  "url",
  "util",
  "util/types",
  "v8",
  "vm",
  "wasi",
  "worker_threads",
  "zlib"
])

export const platformPackages = Object.freeze([
  "better-sqlite3",
  "electron",
  "node-pty",
  "playwright",
  "playwright-core",
  "ws"
])

export const ambientPlatformObjects = Object.freeze([
  "Bun",
  "Deno",
  "caches",
  "console",
  "cookieStore",
  "document",
  "history",
  "indexedDB",
  "localStorage",
  "location",
  "navigator",
  "performance",
  "process",
  "screen",
  "sessionStorage",
  "window"
])

export const ambientPlatformFunctions = Object.freeze([
  "cancelAnimationFrame",
  "clearImmediate",
  "clearInterval",
  "clearTimeout",
  "fetch",
  "queueMicrotask",
  "requestAnimationFrame",
  "setImmediate",
  "setInterval",
  "setTimeout"
])

export const ambientPlatformConstructors = Object.freeze([
  "BroadcastChannel",
  "EventSource",
  "FileReader",
  "MessageChannel",
  "MessagePort",
  "MutationObserver",
  "ResizeObserver",
  "SharedWorker",
  "WebSocket",
  "Worker",
  "XMLHttpRequest"
])

export const ambientPlatformMembers = Object.freeze([
  "Date.now",
  "Math.random",
  "crypto.getRandomValues",
  "crypto.randomUUID",
  "crypto.subtle",
  "performance.now",
  "performance.timeOrigin"
])

export const listenerMethods = Object.freeze([
  "addEventListener",
  "addListener",
  "off",
  "on",
  "once",
  "removeEventListener",
  "removeListener",
  "subscribe",
  "unsubscribe"
])

export const resourceMethods = Object.freeze([
  "close",
  "postMessage",
  "start",
  "terminate"
])

export const isNodeBuiltin = (source) =>
  source.startsWith("node:") || nodeBuiltinModules.includes(source)

export const isPlatformPackage = (source) =>
  platformPackages.some((candidate) => source === candidate || source.startsWith(`${candidate}/`))
