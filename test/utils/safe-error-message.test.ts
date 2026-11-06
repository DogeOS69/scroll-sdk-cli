import * as toml from '@iarna/toml'
import {expect} from 'chai'
import * as yaml from 'js-yaml'

import {safeErrorMessage} from '../../src/utils/safe-error-message.js'

describe('safeErrorMessage', () => {
  const MARKER = 'NONFUNCTIONAL_PRIVATE_MARKER'

  const parsers: Array<[string, () => unknown]> = [
    ['TOML', () => toml.parse(`a = 1\napi_key = ${MARKER}\n`)],
    ['YAML', () => yaml.load(`a: 1\npassword: "${MARKER}" oops\n`)],
  ]
  for (const [name, parse] of parsers) {
    it(`omits the source line ${name} parse errors quote`, () => {
      let failure: unknown
      try {parse()} catch (error) {failure = error}
      expect((failure as Error).message, 'the parser must quote the input for this test to mean anything').to.include(MARKER)
      expect(safeErrorMessage(failure)).to.equal('input could not be parsed (contents omitted)')
    })
  }

  for (const [input, expected] of [
    [`postgres://admin:${MARKER}/abc@db.internal:5432/app`, 'postgres://db.internal:5432'],
    [`postgres://admin:${MARKER}@pass@db.internal:5432/app`, 'postgres://db.internal:5432'],
    [`postgres://${MARKER}@db.internal/app?sslmode=require`, 'postgres://db.internal'],
    [`db admin:${MARKER}@host:5432`, 'db [redacted]@host:5432'],
    [`dial failed host=db password=${MARKER}`, 'dial failed host=db password=[redacted]'],
    [`bad api_key: ${MARKER}`, 'bad api_key: [redacted]'],
    [`oauth client_secret=${MARKER} rejected`, 'oauth client_secret=[redacted] rejected'],
    [`oauth access_token=${MARKER}`, 'oauth access_token=[redacted]'],
    [`bad private_key=${MARKER}`, 'bad private_key=[redacted]'],
    [`body {"token":"${MARKER}"}`, 'body {"token":[redacted]}'],
    [`body {"password": "two ${MARKER} words"}`, 'body {"password": [redacted]}'],
    [`body {"client_secret":"a\\"b ${MARKER}"}`, 'body {"client_secret":[redacted]}'],
    [`body {\\"token\\":\\"${MARKER}\\"}`, 'body {\\"token\\":[redacted]'],
    [`Authorization: Bearer ${MARKER}`, 'Authorization: [redacted]'],
    [`Authorization: ${MARKER}`, 'Authorization: [redacted]'],
    [`{"authorization":"Basic ${MARKER}"}`, '{"authorization":"[redacted]"}'],
    [`sent bearer ${MARKER} upstream`, 'sent bearer [redacted] upstream'],
  ]) {
    it(`removes the credentials from ${input.replace(MARKER, '<marker>')}`, () => {
      expect(safeErrorMessage(new Error(input))).to.equal(expected)
    })
  }

  it('keeps Kubernetes wording that names a Secret without a value', () => {
    const message = 'Error from server (NotFound): secrets "signer-env" not found'
    expect(safeErrorMessage(new Error(message))).to.equal(message)
  })

  it('keeps an ordinary validation message readable', () => {
    expect(safeErrorMessage(new Error('tested build bindings must be an object'))).to.equal('tested build bindings must be an object')
  })

  it('omits the source text Node quotes in JSON parse errors', () => {
    let failure: unknown
    try {JSON.parse(`{"token": "${MARKER}"`)} catch (error) {failure = error}
    expect(safeErrorMessage(failure)).to.equal('input is not valid JSON (contents omitted)')
  })

  it('removes opaque values and URL credentials, paths and queries', () => {
    const message = safeErrorMessage(new Error(`bad token ${MARKER}_${'a'.repeat(40)} from https://user:${MARKER}@api.example.test/v0/org/${MARKER}?key=${MARKER}#${MARKER}`))
    expect(message).to.not.include(MARKER)
    expect(message).to.include('https://api.example.test')
    expect(message).to.include('[redacted]')
  })

  it('collapses whitespace and bounds the length', () => {
    expect(safeErrorMessage(new Error('first\n\n  second'))).to.equal('first second')
    expect(safeErrorMessage(new Error('word '.repeat(200)))).to.have.length.at.most(403)
  })

  it('reports nothing for a value that is not an Error or has no message', () => {
    expect(safeErrorMessage('text')).to.equal(undefined)
    expect(safeErrorMessage(new Error('  '))).to.equal(undefined)
  })
})
