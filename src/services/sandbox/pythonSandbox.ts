/**
 * Python 沙箱运行器：管理单例 Worker，支持超时终止。
 * 首次调用会从同源 /pyodide/ 加载 Pyodide（约数 MB，浏览器会缓存）。
 */

export type PythonResult = {
  ok: boolean
  stdout: string
  stderr: string
  result: string
  images: string[]
  error?: string
}

type Pending = {
  resolve: (value: PythonResult) => void
  timer: number
}

let worker: Worker | null = null
let sequence = 0
const pending = new Map<number, Pending>()

const failAll = (error: string) => {
  for (const [id, item] of pending) {
    window.clearTimeout(item.timer)
    item.resolve({ ok: false, stdout: '', stderr: '', result: '', images: [], error })
    pending.delete(id)
  }
}

const ensureWorker = (): Worker => {
  if (worker) {
    return worker
  }
  worker = new Worker(new URL('../../workers/pythonWorker.ts', import.meta.url))
  worker.onmessage = (event: MessageEvent<PythonResult & { id: number }>) => {
    const item = pending.get(event.data.id)
    if (!item) {
      return
    }
    pending.delete(event.data.id)
    window.clearTimeout(item.timer)
    item.resolve(event.data)
  }
  worker.onerror = (event) => {
    failAll(event.message || 'Python worker failed')
    worker?.terminate()
    worker = null
  }
  return worker
}

/** 在 Web Worker 中执行 Python；超时则终止 Worker 并返回错误 */
export const runPythonSandbox = (code: string, timeoutMs = 120000): Promise<PythonResult> => {
  const id = ++sequence
  return new Promise<PythonResult>((resolve) => {
    const current = ensureWorker()
    const timer = window.setTimeout(() => {
      pending.delete(id)
      current.terminate()
      worker = null
      resolve({
        ok: false,
        stdout: '',
        stderr: '',
        result: '',
        images: [],
        error: `Python 执行超时（${Math.round(timeoutMs / 1000)}s）`,
      })
    }, timeoutMs)
    pending.set(id, { resolve, timer })
    current.postMessage({ id, code })
  })
}
