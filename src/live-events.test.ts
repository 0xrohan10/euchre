import { describe, expect, it } from 'vitest'
import { LIVE_EVENT_PROTOCOL_VERSION, frameLiveEvent, isProtocolMessage } from './live-events'

describe('live event protocol', () => {
  it('frames named versioned JSON events', () => {
    expect(
      frameLiveEvent('heartbeat', {
        version: LIVE_EVENT_PROTOCOL_VERSION,
        at: 123,
      }),
    ).toBe('event: heartbeat\ndata: {"version":1,"at":123}\n\n')
  })

  it('rejects messages from unknown protocol versions', () => {
    expect(isProtocolMessage({ version: 1 })).toBe(true)
    expect(isProtocolMessage({ version: 2 })).toBe(false)
    expect(isProtocolMessage(null)).toBe(false)
  })
})
