export const env = {}

export function waitUntil(promise: Promise<unknown>): void {
  void promise
}
