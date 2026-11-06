const MAX_LENGTH = 400
// Bounds the patterns' backtracking on a very long message.
const MAX_INPUT_LENGTH = 4000
const JSON_PARSE_FAILURE = /is not valid JSON|in JSON at position|Unexpected end of JSON|Unexpected token .* JSON/
// These parsers quote the offending source line in their messages.
const PARSER_ERRORS = new Set(['SyntaxError', 'TomlError', 'YAMLException'])
const URL_WITH_DETAILS = /\b([a-z][\d+.a-z-]*:\/\/)(\S+)/gi
const BARE_CREDENTIALS = /[^\s/:@]+:\S*@(?=\S)/g
// A key may carry a prefix or suffix (client_secret, access_token) and be quoted as JSON.
const NAMED_SECRET = /([\w-]*(?:api[_-]?key|credential|passw(?:or)?d|private[_-]?key|pwd|secret|token)[\w-]*["'\\]*\s*[:=]\s*)(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\S+)/gi
// These values can contain spaces or brackets. An array removes the rest of the message, anything else the rest of the line.
const LINE_SECRET = /((?:authorization|cookie|mnemonic|seed)[\w-]*(?:\s+phrase)?["'\\]*\s*[:=]\s*)(?:\[[\S\s]*|[^\n\r]*)/gi
const BEARER_TOKEN = /\b(bearer\s+)\S+/gi
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
    .slice(0, MAX_INPUT_LENGTH)
    .replaceAll(URL_WITH_DETAILS, urlWithoutDetails)
    // Before BARE_CREDENTIALS, which would remove the key name from `{"cookie":"a@b"}`.
    .replaceAll(LINE_SECRET, '$1[redacted]')
    .replaceAll(BARE_CREDENTIALS, '[redacted]@')
    .replaceAll(BEARER_TOKEN, '$1[redacted]')
    .replaceAll(NAMED_SECRET, '$1[redacted]')
    .replaceAll(OPAQUE_VALUE, '[redacted]')
    .replaceAll(/\s+/g, ' ')
    .trim()
  if (!message) return undefined
  return message.length > MAX_LENGTH ? `${message.slice(0, MAX_LENGTH)}...` : message
}
