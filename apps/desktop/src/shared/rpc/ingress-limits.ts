/**
 * Shared ingress bounds for the desktop MessagePort RPC transports.
 *
 * Both directions (renderer → main and main → renderer) buffer inbound
 * frames in an Effect queue drained by a single decoding fiber. Without
 * explicit bounds a peer posting faster than the decoder drains retains
 * unbounded cloned frames until the process dies. These limits cap, per
 * connection, the encoded size of one frame, the number of queued frames,
 * and the total retained bytes across queued frames.
 *
 * The numbers are deliberately conservative: RPC frames are small JSON
 * envelopes, so a 1 MiB frame is already pathological, 128 queued frames
 * absorb legitimate bursts, and 8 MiB retained bounds the worst case well
 * below anything that threatens the main process.
 */
export interface RpcIngressLoad {
  readonly queuedFrames: number
  readonly retainedBytes: number
}

export type RpcIngressFrame = string | Uint8Array

export type RpcIngressRejection = "unsupported-frame" | "oversize-frame" | "queue-overflow"

export type RpcIngressAdmission =
  | { readonly admitted: true; readonly size: number }
  | { readonly admitted: false; readonly reason: RpcIngressRejection }

export const RPC_INGRESS_MAX_FRAME_BYTES = 1_048_576
export const RPC_INGRESS_MAX_QUEUED_FRAMES = 128
export const RPC_INGRESS_MAX_RETAINED_BYTES = 8_388_608

export const isRpcIngressFrame = (data: unknown): data is RpcIngressFrame =>
  typeof data === "string" || data instanceof Uint8Array

/**
 * Estimated retained bytes for an admitted frame. Strings are counted by
 * UTF-16 code unit, binary frames by byte length; both are stable,
 * monotonic estimates for backpressure accounting, not exact heap sizes.
 */
export const rpcIngressFrameSize = (frame: RpcIngressFrame): number =>
  typeof frame === "string" ? frame.length : frame.byteLength

/**
 * Pure admission check shared by both transports and their tests. Returns
 * `admitted` only when the frame has a supported type, fits the per-frame
 * cap, and fits within both the queued-count and retained-bytes bounds.
 */
export const admitRpcIngressFrame = (data: unknown, load: RpcIngressLoad): RpcIngressAdmission => {
  if (!isRpcIngressFrame(data)) return { admitted: false, reason: "unsupported-frame" }
  const size = rpcIngressFrameSize(data)
  if (size > RPC_INGRESS_MAX_FRAME_BYTES) return { admitted: false, reason: "oversize-frame" }
  if (
    load.queuedFrames + 1 > RPC_INGRESS_MAX_QUEUED_FRAMES ||
    load.retainedBytes + size > RPC_INGRESS_MAX_RETAINED_BYTES
  ) {
    return { admitted: false, reason: "queue-overflow" }
  }
  return { admitted: true, size }
}
