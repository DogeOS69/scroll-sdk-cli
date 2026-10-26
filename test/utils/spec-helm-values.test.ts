import {expect} from 'chai'
import * as yaml from 'js-yaml'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {applyHelmValues, writeHelmValues} from '../../src/utils/spec-helm-values.js'

describe('persistent Helm overrides', () => {
  it('merges resource and monitoring tuning into standard values and reapplies after rendering', () => {
    const files = {'l2-reth-rpc-production.yaml': 'resources:\n  requests: {cpu: "4", memory: 16Gi}\n  limits: {memory: 32Gi}\n', 'scroll-monitor-production.yaml': 'loki: {persistence: {size: 100Gi}}\n'}
    const spec = {helmValues: {'l2-reth-rpc-production.yaml': 'resources: {requests: {cpu: 500m, memory: 2Gi}}', 'scroll-monitor-production.yaml': 'loki: {persistence: {size: 20Gi}}'}}
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-overrides-'))
    try {
      fs.mkdirSync(path.join(root, 'values'))
      for (let attempt = 0; attempt < 2; attempt++) {
        for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(root, 'values', name), content)
        writeHelmValues(root, spec)
        expect(yaml.load(fs.readFileSync(path.join(root, 'values/l2-reth-rpc-production.yaml'), 'utf8'))).deep.eq({resources: {limits: {memory: '32Gi'}, requests: {cpu: '500m', memory: '2Gi'}}})
        expect(fs.readFileSync(path.join(root, 'values/scroll-monitor-production.yaml'), 'utf8')).include('20Gi')
      }
    } finally {fs.rmSync(root, {force: true, recursive: true})}
  })
  it('rejects overlays that overwrite spec-owned status-page intent', () => {
    for (const content of ['statusPage: {enabled: false}', 'statusPage: {environment: mainnet}']) {
      const files = {'scroll-monitor-production.yaml': 'statusPage: {enabled: true, environment: testnet}'}
      expect(() => applyHelmValues(files, {helmValues: {'scroll-monitor-production.yaml': content}, monitoring: {statusPage: {enabled: true}}})).throw('spec-owned fields')
      expect(files['scroll-monitor-production.yaml']).eq('statusPage: {enabled: true, environment: testnet}')
    }
  })
  it('rejects unknown files, traversal, malformed mappings and partial updates', () => {
    for (const overlay of [{'missing.yaml': '{}'}, {'../config.yaml': '{}'}, {'a.yaml': '- invalid'}, {'a.yaml': 'bad: ['}] as Array<Record<string, string>>) {
      const files = {'a.yaml': 'enabled: true'}
      expect(() => applyHelmValues(files, {helmValues: overlay})).throw()
      expect(files['a.yaml']).eq('enabled: true')
    }
  })
})
