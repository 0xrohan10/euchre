import { env, runInDurableObject } from 'cloudflare:test'
import { describe, expect, it, vi } from 'vitest'

describe('RoomCoordinator in workerd', () => {
  it('installs an alarm when an interleaved signal races with a failed pass', async () => {
    const stub = env.ROOM_COORDINATOR.getByName(crypto.randomUUID())

    await runInDurableObject(stub, async (instance, state) => {
      let rejectFirst!: (error: Error) => void
      const run = vi
        .fn<() => Promise<void>>()
        .mockImplementationOnce(() => {
          return new Promise<void>((_resolve, reject) => {
            rejectFirst = reject
          })
        })
        .mockResolvedValue(undefined)
      const coordinator = instance as unknown as {
        alarm(): Promise<void>
        reconcile(): Promise<void>
        run(): Promise<void>
      }
      coordinator.run = run

      const first = coordinator.reconcile()
      await Promise.resolve()
      const interleaved = coordinator.reconcile()
      rejectFirst(new Error('transient database failure'))

      await expect(first).rejects.toThrow('transient database failure')
      await expect(interleaved).rejects.toThrow('transient database failure')
      expect(await state.storage.getAlarm()).not.toBeNull()

      await coordinator.alarm()
      expect(run).toHaveBeenCalledTimes(2)
    })
  })

  it('closes an initial stream when its first reconciliation fails', async () => {
    const roomId = crypto.randomUUID()
    const stub = env.ROOM_COORDINATOR.getByName(roomId)

    await runInDurableObject(stub, async (instance) => {
      const admissionActions: string[] = []
      const coordinator = instance as unknown as {
        connections: Map<string, unknown>
        env: Env
        fetch(request: Request): Promise<Response>
        run(): Promise<void>
      }
      coordinator.env = {
        LIVE_STREAM_ADMISSION: {
          getByName: () => {
            return {
              fetch: async (input: RequestInfo | URL) => {
                admissionActions.push(new URL(String(input)).pathname)
                return new Response(null, { status: 204 })
              },
            }
          },
        },
      } as unknown as Env
      coordinator.run = async () => {
        throw new Error('transient database failure')
      }

      const response = await coordinator.fetch(
        new Request('https://room-coordinator/connect', {
          method: 'POST',
          body: JSON.stringify({
            roomId,
            userId: 'workerd-user',
            pageId: crypto.randomUUID(),
            leaseId: crypto.randomUUID(),
          }),
        }),
      )

      expect(response.status).toBe(503)
      expect(response.headers.get('x-room-coordinator-admission')).toBe('returned')
      expect(coordinator.connections.size).toBe(0)
      expect(admissionActions).toEqual(['/transfer', '/return'])
    })
  })

  it('releases a transferred capability once when returning it fails', async () => {
    const roomId = crypto.randomUUID()
    const stub = env.ROOM_COORDINATOR.getByName(roomId)

    await runInDurableObject(stub, async (instance) => {
      const admissionActions: string[] = []
      const coordinator = instance as unknown as {
        env: Env
        fetch(request: Request): Promise<Response>
        run(): Promise<void>
      }
      coordinator.env = {
        LIVE_STREAM_ADMISSION: {
          getByName: () => {
            return {
              fetch: async (input: RequestInfo | URL) => {
                const action = new URL(String(input)).pathname
                admissionActions.push(action)
                return new Response(null, { status: action === '/return' ? 409 : 204 })
              },
            }
          },
        },
      } as unknown as Env
      coordinator.run = async () => {
        throw new Error('transient database failure')
      }

      const response = await coordinator.fetch(
        new Request('https://room-coordinator/connect', {
          method: 'POST',
          body: JSON.stringify({
            roomId,
            userId: 'workerd-user',
            pageId: crypto.randomUUID(),
            leaseId: crypto.randomUUID(),
          }),
        }),
      )

      expect(response.status).toBe(503)
      expect(response.headers.get('x-room-coordinator-admission')).toBe('released')
      expect(admissionActions).toEqual(['/transfer', '/return', '/release'])
    })
  })
})
