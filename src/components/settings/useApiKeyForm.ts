import { useState } from 'react'
import { ApiError } from '../../services/api/client.js'
import { classifyApiError } from '../../services/api/errors.js'
import { useTranslate } from '../../i18n/index.js'

export type ApiKeyFormOptions = {
  /** 校验通过后保存 Key */
  save: (apiKey: string) => void
  /** 校验方式（GET /models 之类，不产生生成费用） */
  verify: (apiKey: string) => Promise<void>
  onSaved?: () => void
}

/** 输入 API Key 后先用 verify 校验，通过才保存 */
export const useApiKeyForm = ({ save, verify, onSaved }: ApiKeyFormOptions) => {
  const t = useTranslate()
  const [value, setValue] = useState('')
  const [verifying, setVerifying] = useState(false)
  const [failure, setFailure] = useState<{ cause: unknown } | null>(null)
  const cause = failure?.cause
  const error =
    failure === null
      ? null
      : classifyApiError(cause) === 'unauthorized'
        ? t('apiKeyInvalid')
        : classifyApiError(cause) === 'network'
          ? t('commonNetworkErrorToast')
          : t('apiKeyVerificationFailed', {
              message:
                cause instanceof ApiError && cause.localMessage
                  ? t(cause.localMessage.key, cause.localMessage.params)
                  : cause instanceof Error
                    ? cause.message
                    : String(cause),
            })

  const submit = async () => {
    const apiKey = value.trim()
    if (!apiKey || verifying) {
      return
    }
    setVerifying(true)
    setFailure(null)
    try {
      await verify(apiKey)
      save(apiKey)
      setValue('')
      onSaved?.()
    } catch (e) {
      setFailure({ cause: e })
    } finally {
      setVerifying(false)
    }
  }

  return { value, setValue, verifying, error, submit }
}
