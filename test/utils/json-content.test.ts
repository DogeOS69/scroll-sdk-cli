import {expect} from 'chai'

import {canonicalJson, jsonContentEqual} from '../../src/utils/json-content.js'

describe('JSON content comparison', () => {
  it('ignores whitespace, object order, string escapes and equivalent number notation', () => {
    expect(jsonContentEqual('{"a":1,"nested":{"b":"x","c":[2,3]}}', '\n{ "nested": {"c":[2.0,3e0],"b":"\\u0078"}, "a":1e0 }\n')).equal(true)
    expect(jsonContentEqual(Buffer.from('{"n":18446744073709551615}'), '{"n":18446744073709551615}\n')).equal(true)
    expect(jsonContentEqual('{"n":18446744073709551615}', '{"n":184467440737095516150e-1}')).equal(true)
  })
  it('distinguishes large integers, types, array order and string content', () => {
    for (const [left, right] of [
      ['{"n":18446744073709551615}', '{"n":18446744073709551614}'],
      ['{"n":1}', '{"n":"1"}'],
      ['{"n":1}', '{"n":{"coefficient":"1","exponent":"0"}}'],
      ['[1,2]', '[2,1]'],
      ['{"token":"test"}', '{"token":"test "}'],
    ]) expect(jsonContentEqual(left, right)).equal(false)
  })
  it('rejects malformed or ambiguous JSON without exposing its contents', () => {
    for (const value of [undefined, {}, '', '{"token":"NONFUNCTIONAL_TEST",}', '{"a":1,"a":2}']) {
      expect(jsonContentEqual(value, value)).equal(false)
    }
  })
  it('keeps operation IDs stable across object order without sorting arrays', () => {
    // eslint-disable-next-line perfectionist/sort-objects -- Compare deliberately reordered objects.
    expect(canonicalJson({b: {y: 1, x: 2}, a: [1, 2]})).equal(canonicalJson({a: [1, 2], b: {x: 2, y: 1}}))
    expect(canonicalJson({a: [1, 2]})).not.equal(canonicalJson({a: [2, 1]}))
  })
})
