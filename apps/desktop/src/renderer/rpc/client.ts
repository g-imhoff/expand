import { Effect, Queue, Stream } from "effect"
import { RpcClient, type RpcMessage, RpcSerialization } from "effect/unstable/rpc"
import { YodeaRpcs } from "@yodea/contracts/rpc"

// A structural port: satisfied by a DOM MessagePort. DOM-free so consumers
// typecheck under the root (non-DOM) tsconfig. Used by port.ts (production wiring)
// and by the in-memory test, which pairs two of these back-to-back.
export interface RendererPortLike {
  postMessage: (message: unknown) => void
  onmessage: ((event: { data: unknown }) => void) | null
  start: () => void
}

// Why a real serialization protocol (and not RpcClient.makeNoSerialization):
//
// makeNoSerialization is for an IN-PROCESS seam — both halves share the same
// live objects. Its FromServer envelope carries a real Effect `Exit` (a class
// instance whose continuation lives on a Symbol-keyed prototype) plus schema
// class instances. The desktop seam, however, crosses a process boundary over an
// Electron MessageChannel, whose postMessage does a STRUCTURED CLONE: that strips
// every prototype and Symbol-keyed property. The cloned `Exit` therefore loses
// its `[evaluate]` symbol; when the client resumes a one-shot request with it the
// fiber dies with "Fiber.runLoop: Not a valid effect: [object Object]". (Streams
// survived only because their inbound Chunk/Exit is read as plain data, never run
// as an effect — which is why the live Events fold masked the broken queries.)
//
// The fix is the schema-aware protocol path (mirrors client-core's socket setup):
// requests/responses are encoded to plain JSON-safe envelopes by RpcSerialization
// before crossing postMessage and decoded back into typed values on arrival, so
// nothing relies on prototypes/symbols surviving the clone. postMessage preserves
// message boundaries, so the unframed `json` serialization is the right fit.
const makePortProtocol = (port: RendererPortLike) =>
  RpcClient.Protocol.make(
    Effect.fnUntraced(function* (writeResponse) {
      const serialization = yield* RpcSerialization.RpcSerialization
      const parser = serialization.makeUnsafe()
      const inbound = yield* Queue.make<string | Uint8Array>()
      port.onmessage = (event) => {
        Queue.offerUnsafe(inbound, event.data as string | Uint8Array)
      }
      port.start()
      // Decode each inbound message and pump every framed response to clientId 0
      // (this seam is one server per port — a single client).
      yield* Stream.fromQueue(inbound).pipe(
        Stream.runForEach((data) => {
          const responses = parser.decode(data) as ReadonlyArray<RpcMessage.FromServerEncoded>
          return Effect.forEach(responses, (response) => writeResponse(0, response), { discard: true })
        }),
        Effect.forkScoped
      )
      return {
        send: (_clientId: number, request) =>
          Effect.sync(() => {
            const encoded = parser.encode(request)
            if (encoded !== undefined) port.postMessage(encoded)
          }),
        supportsAck: true,
        supportsTransferables: false
      }
    })
  )

// Build the serialized RpcClient over a renderer-side port. The client and its
// transport receive loop are owned by the supplied connection scope, which the
// caller keeps open for the connection's lifetime (see port.ts). Returns the
// typed contract client; outbound requests are encoded onto the port and inbound
// responses are decoded back into typed values.
export const buildClient = (port: RendererPortLike) =>
  RpcClient.make(YodeaRpcs).pipe(
    Effect.provideServiceEffect(RpcClient.Protocol, makePortProtocol(port)),
    Effect.provideService(RpcSerialization.RpcSerialization, RpcSerialization.json)
  )
