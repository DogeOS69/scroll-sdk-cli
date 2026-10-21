import {parse} from 'lossless-json'
import {isDeepStrictEqual} from 'node:util'

// Keep JSON numbers exact, including u64 protocol fields. A class distinguishes
// numbers from JSON objects with similarly named properties.
class JsonNumber {
  readonly coefficient: string
  readonly exponent: string

  constructor(source: string) {
    const [mantissa, power = '0'] = source.toLowerCase().split('e')
    const fraction = mantissa.split('.')[1]?.length ?? 0
    const digits = mantissa.replace('.', '')
    const coefficient = BigInt(digits).toString()
    const trailing = coefficient === '0' ? 0 : coefficient.length - coefficient.replace(/0+$/, '').length
    this.coefficient = coefficient === '0' ? '0' : coefficient.slice(0, coefficient.length - trailing)
    this.exponent = coefficient === '0' ? '0' : (BigInt(power) - BigInt(fraction) + BigInt(trailing)).toString()
  }
}

/** Compare delivered JSON content, without exposing parser errors or credentials. */
export function jsonContentEqual(left: unknown, right: unknown): boolean {
  const text = (value: unknown): string => {
    if (Buffer.isBuffer(value)) return value.toString('utf8')
    if (typeof value === 'string') return value
    throw new Error('Expected JSON text')
  }

  try {
    const options = {parseNumber: (value: string) => new JsonNumber(value)}
    return isDeepStrictEqual(parse(text(left), undefined, options), parse(text(right), undefined, options))
  } catch {return false}
}

/** Stable serialization for operation IDs; object property order is not intent. */
export function canonicalJson(value: unknown): string {
  const canonical = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(value => canonical(value))
    if (item && typeof item === 'object') return Object.fromEntries(Object.keys(item).sort().map(key => [key, canonical((item as Record<string, unknown>)[key])]))
    return item
  }

  return JSON.stringify(canonical(value))
}
