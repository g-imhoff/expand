import { Layer } from "effect"
import { ClientLayer } from "@expand/client-ts"
import { ProcessServices } from "@expand/client-ts/adapters/node"
import { nodeAppContextLayer } from "./node-app-context"

export const clientLayer = (runtimeAdapter: Parameters<typeof ClientLayer>[0]) =>
  ClientLayer(runtimeAdapter).pipe(
    Layer.provide(Layer.mergeAll(
      nodeAppContextLayer,
      ProcessServices.processControlLayer
    ))
  )
