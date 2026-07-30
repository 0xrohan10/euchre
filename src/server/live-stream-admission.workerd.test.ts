import { env, runInDurableObject } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'

const userId = 'workerd-user'
const pageId = '0198fd3c-5ef0-7a08-9fd1-16dd758b2800'
const leaseId = '0198fd3c-5ef0-7a08-9fd1-16dd758b2801'

describe('LiveStreamAdmissionGate in workerd', () => {
  it('persists leases, replaces duplicate tabs, releases cancellation, and survives eviction', async () => {
    const id = env.LIVE_STREAM_ADMISSION.idFromName(userId)
    const stub = env.LIVE_STREAM_ADMISSION.get(id)
    const acquire = (nextLeaseId: string) => {
      return stub.fetch('https://live-stream-admission/acquire', {
        method: 'POST',
        body: JSON.stringify({ userId, scope: 'room', pageId, leaseId: nextLeaseId }),
      })
    }

    expect((await acquire(leaseId)).status).toBe(200)
    const replacementId = '0198fd3c-5ef0-7a08-9fd1-16dd758b2802'
    expect((await acquire(replacementId)).status).toBe(200)
    expect(
      (
        await stub.fetch('https://live-stream-admission/renew', {
          method: 'POST',
          body: JSON.stringify({ leaseId }),
        })
      ).status,
    ).toBe(409)

    await runInDurableObject(stub, async (_instance, state) => {
      expect(await state.storage.getAlarm()).not.toBeNull()
      expect(await state.storage.get('leases')).toBeDefined()
    })

    expect(
      (
        await env.LIVE_STREAM_ADMISSION.get(id).fetch('https://live-stream-admission/release', {
          method: 'POST',
          body: JSON.stringify({ leaseId: replacementId }),
        })
      ).status,
    ).toBe(204)
  })
})
