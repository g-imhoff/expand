export const promiseStaticMethods = Object.freeze([
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

export const effectCallbackMethods = Object.freeze([
  "acquireRelease",
  "andThen",
  "async",
  "catch",
  "catchAll",
  "catchAllCause",
  "catchIf",
  "catchTag",
  "catchTags",
  "filterOrElse",
  "filterOrFail",
  "flatMap",
  "fn",
  "fnUntraced",
  "forEach",
  "gen",
  "if",
  "iterate",
  "loop",
  "map",
  "mapBoth",
  "mapError",
  "match",
  "matchCause",
  "matchCauseEffect",
  "matchEffect",
  "onError",
  "onExit",
  "onInterrupt",
  "orElse",
  "promise",
  "reduce",
  "reduceEffect",
  "repeatOrElse",
  "retryOrElse",
  "suspend",
  "sync",
  "tap",
  "tapBoth",
  "tapError",
  "tapErrorCause",
  "timeoutTo",
  "transform",
  "transformOrFail",
  "try",
  "tryPromise",
  "unless",
  "when",
  "whileLoop"
])

export const schemaSyncMethods = Object.freeze([
  "decodeSync",
  "decodeUnknownSync",
  "encodeSync",
  "encodeUnknownSync",
  "validateSync"
])

export const nodeBuiltinModules = Object.freeze([
  "assert",
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
  "domain",
  "events",
  "fs",
  "http",
  "http2",
  "https",
  "inspector",
  "module",
  "net",
  "os",
  "path",
  "perf_hooks",
  "process",
  "punycode",
  "querystring",
  "readline",
  "repl",
  "sea",
  "sqlite",
  "stream",
  "string_decoder",
  "sys",
  "test",
  "timers",
  "tls",
  "trace_events",
  "tty",
  "url",
  "util",
  "v8",
  "vm",
  "wasi",
  "worker_threads",
  "zlib"
])

export const hostModules = Object.freeze(["better-sqlite3", "electron", "ws"])

export const processMembers = Object.freeze([
  "arch",
  "argv",
  "chdir",
  "cpuUsage",
  "cwd",
  "env",
  "execArgv",
  "execPath",
  "exit",
  "getegid",
  "geteuid",
  "getgid",
  "getgroups",
  "getuid",
  "hrtime",
  "kill",
  "memoryUsage",
  "nextTick",
  "pid",
  "platform",
  "ppid",
  "resourceUsage",
  "setegid",
  "seteuid",
  "setgid",
  "setgroups",
  "setuid",
  "stderr",
  "stdin",
  "stdout",
  "title",
  "umask",
  "uptime",
  "version",
  "versions"
])

export const timerGlobals = Object.freeze([
  "clearImmediate",
  "clearInterval",
  "clearTimeout",
  "queueMicrotask",
  "requestAnimationFrame",
  "cancelAnimationFrame",
  "setImmediate",
  "setInterval",
  "setTimeout"
])

export const platformFunctionGlobals = Object.freeze(["fetch", ...timerGlobals])

export const platformConstructorGlobals = Object.freeze([
  "BroadcastChannel",
  "EventSource",
  "FileReader",
  "FileSystemObserver",
  "MessageChannel",
  "MessagePort",
  "Notification",
  "Request",
  "SharedWorker",
  "WebSocket",
  "Worker",
  "XMLHttpRequest"
])

export const browserResourceGlobals = Object.freeze([
  "caches",
  "document",
  "history",
  "indexedDB",
  "localStorage",
  "location",
  "navigator",
  "screen",
  "sessionStorage",
  "window"
])

export const listenerMethods = Object.freeze([
  "addEventListener",
  "addListener",
  "off",
  "on",
  "once",
  "removeEventListener",
  "removeListener"
])
