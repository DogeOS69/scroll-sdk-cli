import {expect} from 'chai'

import {safeErrorMessage} from '../../src/utils/safe-error-message.js'

describe('safeErrorMessage', () => {
  const MARKER = 'NONFUNCTIONAL_PRIVATE_MARKER'

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
