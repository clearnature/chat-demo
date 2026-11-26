import type { SandboxPart } from '../chat/types.js'
import { updateSandboxPart } from '../chat/store.js'
import { runPythonSandbox } from './pythonSandbox.js'

const formatOutput = (stdout: string, stderr: string, result: string): string => {
  const parts = [
    stdout.trim(),
    stderr.trim() ? `[stderr]\n${stderr.trim()}` : '',
    result.trim() ? `[Return] ${result.trim()}` : '',
  ].filter(Boolean)
  return parts.join('\n')
}

/** 重新运行 Python 沙箱产物：更新消息里的 sandbox 块并返回最新产物 */
export const rerunPythonSandbox = async (
  part: SandboxPart,
  sessionId: string | null
): Promise<SandboxPart> => {
  const running: SandboxPart = { ...part, status: 'running', output: undefined, images: undefined, error: undefined }
  if (sessionId) {
    updateSandboxPart(sessionId, part.id, () => running)
  }
  const result = await runPythonSandbox(part.code)
  const stdout = result.stdout ?? ''
  const stderr = result.stderr ?? ''
  const returnValue = result.result ?? ''
  const updated: SandboxPart = {
    ...part,
    status: result.ok ? 'done' : 'failed',
    output: formatOutput(stdout, stderr, returnValue) || undefined,
    images: result.images && result.images.length > 0 ? result.images : undefined,
    error: result.ok ? undefined : result.error,
  }
  if (sessionId) {
    updateSandboxPart(sessionId, part.id, () => updated)
  }
  return updated
}
