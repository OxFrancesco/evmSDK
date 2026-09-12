import type { TuiWorkerMessage, TuiWorkerRequest, TuiWorkerResult, TuiWorkerTask, TuiWorkerUpdate } from './worker-protocol'

type Pending = {
  resolve: (result: TuiWorkerResult) => void
  reject: (error: Error) => void
  update?: (update: TuiWorkerUpdate) => void
}

function createWorker(): Worker {
  const path = new URL(import.meta.url.endsWith('.ts') ? './worker.ts' : './worker.js', import.meta.url)
  return new Worker(path, { name: 'aero-data' })
}

export class TuiWorkerClient {
  private worker: Worker | undefined
  private nextId = 0
  private pending = new Map<number, Pending>()

  constructor(private readonly spawn = createWorker, private readonly onRpc = () => {}) {}

  private connect(): Worker {
    if (this.worker) return this.worker
    const worker = this.spawn()
    this.worker = worker
    worker.onmessage = ({ data }: MessageEvent<TuiWorkerMessage>) => {
      if (this.worker !== worker) return
      if (data.kind === 'rpc') return this.onRpc()
      const pending = this.pending.get(data.id)
      if (!pending) return
      if (data.kind === 'action-update' || data.kind === 'analytics-update') return pending.update?.(data)
      this.pending.delete(data.id)
      if (data.kind === 'error') pending.reject(new Error(data.message))
      else pending.resolve(data.result)
    }
    worker.onerror = (event) => {
      event.preventDefault()
      if (this.worker === worker) this.stop(new Error(event.message || 'Aero data worker failed'))
    }
    worker.addEventListener('close', () => {
      if (this.worker !== worker) return
      this.worker = undefined
      this.stop(new Error('Aero data worker stopped. Retry the action.'))
    })
    return worker
  }

  request(task: TuiWorkerTask, update?: Pending['update']) {
    const id = ++this.nextId
    let worker: Worker | undefined
    const promise = new Promise<TuiWorkerResult>((resolve, reject) => {
      try {
        worker = this.connect()
        this.pending.set(id, { resolve, reject, update })
        worker.postMessage({ ...task, id } satisfies TuiWorkerRequest)
      } catch (cause) {
        this.pending.delete(id)
        reject(cause instanceof Error ? cause : new Error(String(cause)))
      }
    })
    return {
      promise,
      cancel: () => {
        const pending = this.pending.get(id)
        if (!pending) return
        this.pending.delete(id)
        if (worker === this.worker) worker?.postMessage({ kind: 'cancel', id } satisfies TuiWorkerRequest)
        pending.reject(new Error('Aero request cancelled'))
      },
    }
  }

  stop(error = new Error('Aero closed')): void {
    const worker = this.worker
    this.worker = undefined
    for (const pending of this.pending.values()) pending.reject(error)
    this.pending.clear()
    worker?.terminate()
  }
}
