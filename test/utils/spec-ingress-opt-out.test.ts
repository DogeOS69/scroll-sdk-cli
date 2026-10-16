import {expect} from 'chai'
import * as yaml from 'js-yaml'

import {mergeBootstrapValues} from '../../src/utils/spec-bootstrap.js'

describe('bootstrap ingress opt-out', () => {
  it('preserves disabled HTTP and WebSocket ingress while updating hosts', () => {
    const template = 'ingress: {main: {enabled: true}, websocket: {enabled: true}}'
    const generated = 'ingress: {main: {enabled: true, hosts: [new.example]}, websocket: {enabled: true}}'
    const operator = 'ingress: {main: {enabled: false}, websocket: {enabled: false}}'
    expect(yaml.load(mergeBootstrapValues(template, generated, operator))).to.deep.equal({
      ingress: {main: {enabled: false, hosts: ['new.example']}, websocket: {enabled: false}},
    })
    expect(yaml.load(mergeBootstrapValues(template, generated))).to.deep.equal(yaml.load(generated))
  })
})
