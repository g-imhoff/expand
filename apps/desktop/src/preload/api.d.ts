export interface YodeaBridge {
  requestPort: () => void
}

declare global {
  interface Window {
    yodea: YodeaBridge
  }
}
