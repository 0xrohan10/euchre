/* eslint-disable arrow-body-style */
import { describe, expect, it, vi } from 'vitest'
import { DirtyLoop } from './dirty-loop.server'

describe('DirtyLoop', () => {
  it('begins another pass after a signal received during an in-flight pass', async () => {
    let finishFirst!: () => void
    const pass = vi
      .fn<() => Promise<void>>()
      .mockImplementationOnce(() => {
        return new Promise<void>((resolve) => (finishFirst = resolve))
      })
      .mockResolvedValue(undefined)
    const loop = new DirtyLoop(pass)

    const first = loop.signal()
    await Promise.resolve()
    const interleaved = loop.signal()
    expect(pass).toHaveBeenCalledOnce()

    finishFirst()
    await Promise.all([first, interleaved])

    expect(pass).toHaveBeenCalledTimes(2)
  })

  it('installs recovery before exposing a failed pass with an interleaved signal', async () => {
    let failFirst!: (error: Error) => void
    const pass = vi.fn<() => Promise<void>>().mockImplementationOnce(() => {
      return new Promise<void>((_resolve, reject) => (failFirst = reject))
    })
    const recover = vi.fn(async () => {})
    const loop = new DirtyLoop(pass, recover)

    const first = loop.signal()
    await Promise.resolve()
    const interleaved = loop.signal()
    failFirst(new Error('transient'))

    await expect(first).rejects.toThrow('transient')
    await expect(interleaved).rejects.toThrow('transient')
    expect(recover).toHaveBeenCalledOnce()
  })
})
