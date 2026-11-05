const MAX_LENGTH = 400
const JSON_PARSE_FAILURE = /is not valid JSON|in JSON at position|Unexpected end of JSON|Unexpected token .* JSON/
const URL_WITH_DETAILS = /\b([a-z][\d+.a-z-]*:\/\/)(?:[^\s/@]+@)?([^\s#/?]+)[^\s#?]*(?:[#?]\S*)?/gi
const OPAQUE_VALUE = /[\w+./=-]{40,}/g

/**
 * Describe a failure without repeating private input or provider credentials.
 * Node's JSON errors quote the source text, and SDK errors may quote tokens.
 */
export function safeErrorMessage(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined
  if (JSON_PARSE_FAILURE.test(error.message)) return 'input is not valid JSON (contents omitted)'
  const message = error.message
    .replaceAll(URL_WITH_DETAILS, '$1$2')
    .replaceAll(OPAQUE_VALUE, '[redacted]')
    .replaceAll(/\s+/g, ' ')
    .trim()
  if (!message) return undefined
  return message.length > MAX_LENGTH ? `${message.slice(0, MAX_LENGTH)}...` : message
}
