import { DurableObject } from 'cloudflare:workers'
import {
  expireLiveStreamAdmissionLeases,
  handleLiveStreamAdmissionRequest,
} from './live-stream-admission.server'

export class LiveStreamAdmissionGate extends DurableObject<Env> {
  fetch(request: Request): Promise<Response> {
    return handleLiveStreamAdmissionRequest(this.ctx.storage, request)
  }

  alarm(): Promise<void> {
    return expireLiveStreamAdmissionLeases(this.ctx.storage)
  }
}
