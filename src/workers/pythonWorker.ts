/* eslint-disable no-restricted-globals */

/**
 * Python 沙箱 Worker：在 Web Worker 里用 Pyodide（WebAssembly Python）执行代码，
 * 主线程不会被阻塞；stdout/stderr、返回值以及 matplotlib 图表（PNG base64）回传。
 * Pyodide 资源通过同源 /pyodide/ 反代加载（nginx → CDN），避免跨域与网络差异。
 */

type Pyodide = {
  setStdout: (options: { batched: (message: string) => void }) => void
  setStderr: (options: { batched: (message: string) => void }) => void
  loadPackagesFromImports: (code: string) => Promise<void>
  runPythonAsync: (code: string) => Promise<unknown>
}

declare function importScripts(...urls: string[]): void

let pyodidePromise: Promise<Pyodide> | null = null

const loadPyodideRuntime = async (): Promise<Pyodide> => {
  importScripts('/pyodide/pyodide.js')
  const factory = (self as unknown as { loadPyodide?: (opts: { indexURL: string }) => Promise<Pyodide> })
    .loadPyodide
  if (!factory) {
    throw new Error('Pyodide runtime failed to load')
  }
  return factory({ indexURL: '/pyodide/' })
}

const getPyodide = (): Promise<Pyodide> => {
  pyodidePromise ??= loadPyodideRuntime()
  return pyodidePromise
}

type Request = { id: number; code: string }

self.onmessage = async (event: MessageEvent<Request>) => {
  const { id, code } = event.data
  const stdout: string[] = []
  const stderr: string[] = []
  let result = ''
  let images: string[] = []
  try {
    const pyodide = await getPyodide()
    pyodide.setStdout({ batched: (message) => stdout.push(message) })
    pyodide.setStderr({ batched: (message) => stderr.push(message) })
    await pyodide.loadPackagesFromImports(code)
    // Worker 中没有 DOM：matplotlib 必须使用 Agg 后端（默认 wasm 后端会 import document 失败）
    try {
      await pyodide.runPythonAsync("import matplotlib; matplotlib.use('Agg')")
    } catch {
      // 未安装 matplotlib 时忽略
    }
    const value = await pyodide.runPythonAsync(code)
    if (value !== undefined && value !== null) {
      result = String(value)
    }
    try {
      const raw = await pyodide.runPythonAsync(`
import base64, io, json
_images = []
try:
    import matplotlib.pyplot as plt
    for _num in plt.get_fignums():
        _fig = plt.figure(_num)
        _buffer = io.BytesIO()
        _fig.savefig(_buffer, format='png', bbox_inches='tight')
        _images.append(base64.b64encode(_buffer.getvalue()).decode())
    plt.close('all')
except Exception:
    pass
json.dumps(_images)
`)
      images = JSON.parse(String(raw)) as string[]
    } catch {
      // matplotlib 未安装/无图表时忽略
    }
    self.postMessage({ id, ok: true, stdout: stdout.join('\n'), stderr: stderr.join('\n'), result, images })
  } catch (error) {
    self.postMessage({
      id,
      ok: false,
      stdout: stdout.join('\n'),
      stderr: stderr.join('\n'),
      result: '',
      error: error instanceof Error ? error.message : String(error),
      images: [],
    })
  }
}
