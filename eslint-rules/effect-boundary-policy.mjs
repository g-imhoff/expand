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
  "runCallbackWith",
  "runFork",
  "runForkWith",
  "runPromise",
  "runPromiseWith",
  "runPromiseExit",
  "runPromiseExitWith",
  "runSync",
  "runSyncWith",
  "runSyncExit",
  "runSyncExitWith"
])

export const managedRuntimeRunnerMethods = Object.freeze([
  "runCallback",
  "runFork",
  "runPromise",
  "runPromiseExit",
  "runSync",
  "runSyncExit"
])

export const runtimeRunnerMethods = Object.freeze(["makeRunMain"])

export const nodeRuntimeRunnerMethods = Object.freeze(["runMain"])

const callbackForm = ({ direct = [], max, min, properties = [] }) => Object.freeze({
  direct: direct === "all" ? direct : Object.freeze(direct),
  max,
  min,
  properties: Object.freeze(properties.map(([index, names]) => Object.freeze([
    index,
    names === "all" ? names : Object.freeze(names)
  ])))
})

const dataLastCallbackForms = Object.freeze([
  callbackForm({ direct: [0], min: 1, max: 1 }),
  callbackForm({ direct: [1], min: 2, max: 2 })
])

const iterableCallbackForms = Object.freeze([
  callbackForm({ direct: [0], min: 1, max: 2 }),
  callbackForm({ direct: [1], min: 2, max: 3 })
])

const matchCallbackForms = Object.freeze([
  callbackForm({ min: 1, max: 1, properties: [[0, ["onFailure", "onSuccess"]]] }),
  callbackForm({ min: 2, max: 2, properties: [[1, ["onFailure", "onSuccess"]]] })
])

export const effectCallbackOwnership = Object.freeze({
  acquireRelease: Object.freeze([
    callbackForm({ direct: [1], min: 2, max: 3 })
  ]),
  acquireUseRelease: Object.freeze([
    callbackForm({ direct: [1, 2], min: 3, max: 3 })
  ]),
  andThen: dataLastCallbackForms,
  callback: Object.freeze([
    callbackForm({ direct: [0], min: 1, max: 1 })
  ]),
  catch: dataLastCallbackForms,
  catchIf: Object.freeze([
    callbackForm({ direct: [0, 1, 2], min: 2, max: 3 }),
    callbackForm({ direct: [1, 2, 3], min: 3, max: 4 })
  ]),
  catchTag: Object.freeze([
    callbackForm({ direct: [1, 2], min: 2, max: 3 }),
    callbackForm({ direct: [2, 3], min: 3, max: 4 })
  ]),
  catchTags: Object.freeze([
    callbackForm({ direct: [1], min: 1, max: 2, properties: [[0, "all"]] }),
    callbackForm({ direct: [2], min: 2, max: 3, properties: [[1, "all"]] })
  ]),
  filter: iterableCallbackForms,
  filterMap: dataLastCallbackForms,
  flatMap: dataLastCallbackForms,
  fn: Object.freeze([
    callbackForm({ direct: "all", min: 1, max: Number.POSITIVE_INFINITY })
  ]),
  fnUntraced: Object.freeze([
    callbackForm({ direct: "all", min: 1, max: Number.POSITIVE_INFINITY })
  ]),
  forEach: iterableCallbackForms,
  gen: Object.freeze([
    callbackForm({ direct: [0], min: 1, max: 1 }),
    callbackForm({ direct: [1], min: 2, max: 2 })
  ]),
  map: dataLastCallbackForms,
  match: matchCallbackForms,
  matchEffect: matchCallbackForms,
  onError: dataLastCallbackForms,
  onExit: dataLastCallbackForms,
  suspend: Object.freeze([
    callbackForm({ direct: [0], min: 1, max: 1 })
  ]),
  sync: Object.freeze([
    callbackForm({ direct: [0], min: 1, max: 1 })
  ]),
  tap: dataLastCallbackForms,
  tapError: dataLastCallbackForms,
  try: Object.freeze([
    callbackForm({ min: 1, max: 1, properties: [[0, ["catch", "try"]]] })
  ]),
  tryPromise: Object.freeze([
    callbackForm({ direct: [0], min: 1, max: 1, properties: [[0, ["catch", "try"]]] })
  ]),
  validate: iterableCallbackForms
})

export const effectCallbackMethods = Object.freeze(Object.keys(effectCallbackOwnership))

export const effectFunctionMethods = Object.freeze(["fn", "fnUntraced"])

export const schemaSyncMethods = Object.freeze([
  "decodeSync",
  "decodeUnknownSync",
  "encodeSync",
  "encodeUnknownSync"
])

export const deterministicNodeUrlExports = Object.freeze([
  "URL",
  "URLSearchParams"
])

export const hostUrlMethods = Object.freeze([
  "createObjectURL",
  "revokeObjectURL"
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
