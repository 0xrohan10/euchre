export class DirtyLoop {
  private dirty = false
  private running?: Promise<void>

  private readonly pass: () => Promise<void>
  private readonly recover: () => Promise<void>

  constructor(pass: () => Promise<void>, recover: () => Promise<void> = async () => {}) {
    this.pass = pass
    this.recover = recover
  }

  signal(): Promise<void> {
    this.dirty = true
    if (this.running) {
      return this.running
    }
    this.running = this.drain().finally(() => {
      this.running = undefined
    })
    return this.running
  }

  private async drain() {
    while (this.dirty) {
      this.dirty = false
      try {
        await this.pass()
      } catch (error) {
        await this.recover()
        throw error
      }
    }
  }
}
