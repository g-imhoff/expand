export interface BootErrorProps {
  readonly message: string
  readonly onRetry: () => void
}

export const BootError = ({ message, onRetry }: BootErrorProps) => (
  <div role="alert" style={{ fontFamily: "system-ui", padding: 24 }}>
    <p>Expand failed to start: {message}</p>
    <button type="button" onClick={onRetry}>Retry</button>
  </div>
)
