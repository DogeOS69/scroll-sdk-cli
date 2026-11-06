const MAX_LENGTH = 400
const JSON_PARSE_FAILURE = /is not valid JSON|in JSON at position|Unexpected end of JSON|Unexpected token .* JSON/
// These parsers quote the offending source line in their messages.
const PARSER_ERRORS = new Set(['SyntaxError', 'TomlError', 'YAMLException'])
const URL_WITH_DETAILS = /\b([a-z][\d+.a-z-]*:\/\/)(\S+)/gi
const BARE_CREDENTIALS = /[^\s/:@]+:\S*@(?=\S)/g
const NAMED_SECRET = /\b(api[_-]?key|passw(?:or)?d|pwd|secret|token)(\s*[:=]\s*)\S+/gi
const OPAQUE_VALUE = /[\w+./=-]{40,}/g

/** A password may contain `/` or `@`, so the host is only what follows the last `@`. */
function urlWithoutDetails(_url: string, scheme: string, rest: string): string {
  return scheme + rest.slice(rest.lastIndexOf('@') + 1).split(/[#/?]/, 1)[0]
}

/**
 * Describe a failure without repeating private input or provider credentials.
 * Parser errors quote the source text, and SDK errors may quote tokens or
 * connection strings.
 */
export function safeErrorMessage(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined
  if (JSON_PARSE_FAILURE.test(error.message)) return 'input is not valid JSON (contents omitted)'
  if (PARSER_ERRORS.has(error.name)) return 'input could not be parsed (contents omitted)'
  const message = error.message
    .replaceAll(URL_WITH_DETAILS, urlWithoutDetails)
    .replaceAll(BARE_CREDENTIALS, '[redacted]@')
    .replaceAll(NAMED_SECRET, '$1$2[redacted]')
    .replaceAll(OPAQUE_VALUE, '[redacted]')
    .replaceAll(/\s+/g, ' ')
    .trim()
  if (!message) return undefined
  return message.length > MAX_LENGTH ? `${message.slice(0, MAX_LENGTH)}...` : message
}
