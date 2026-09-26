/* eslint-disable @typescript-eslint/no-explicit-any -- Helm/Prometheus fixtures. */
import {expect} from 'chai'
import * as yaml from 'js-yaml'
import {execFileSync} from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import {builtinHealth, normalizeHealth, normalizeProbes} from '../../src/utils/status-page-health.js'

describe('status-page built-in health', () => {
  it('requires explicit business deadlines, continuous production and semantic dependency checks', () => {
    const health = normalizeHealth()
    for (const key of ['deposits', 'withdrawals', 'batch-publication']) expect(builtinHealth(key, 'testnet', '123', health)).to.equal('')
    const catalog = {chainId: '123', components: ['public-rpc','bridge-portal','block-explorer'].map(key => ({endpoints: ['https://example.com'], key})), environment: 'testnet'}
    const probes = normalizeProbes({}, catalog, health)
    expect(probes.missing).to.have.all.keys('sequencing','bridge-portal','block-explorer','node-sync','deposits','withdrawals','batch-publication')
    expect(() => normalizeHealth({minimumProbeLocations: 1})).to.throw('independent')
    expect(() => normalizeProbes({bridgeChecks: [{equals: {}, path: [], url: 'https://key:secret@example.com'}]}, catalog, health)).to.throw('credentials')
  })

  ;(process.env.SCROLL_STATUS_RUNTIME_TEST === '1' ? it : it.skip)('evaluates independent probes, queue eligibility and partial/stale observations in real Prometheus', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'status-health-'))
    const health = normalizeHealth({batchPublicationDeadlineSeconds: 300, depositDeadlineSeconds: 600, withdrawalDeadlineSeconds: 900})
    const probe = builtinHealth('public-rpc', 'testnet', '123', health)
    const business = builtinHealth('deposits', 'testnet', '123', health)
    const tests: any[] = []
    const scenario = (expr: string, series: Record<string, string>, expected: null | number) => tests.push({input_series: Object.entries(series).map(([series, values]) => ({series, values})), interval: '1m',
      promql_expr_test: [{eval_time: '10m', exp_samples: expected === null ? [] : [{labels: '{}', value: expected}], expr}]})
    const external = (a: string, b: string, stamp = '600') => Object.fromEntries([['a', a], ['b', b]].flatMap(([location, value]) => {
      const labels = `{environment="testnet",chain_id="123",component_key="public-rpc",location="${location}"}`
      return [[`scroll_status_probe_affected${labels}`, Array.from({length: 11}).fill(value).join(' ')], [`scroll_status_probe_timestamp_seconds${labels}`, `${stamp}x10`]]
    }))
    scenario(probe, external('0','0'), 0)
    scenario(probe, external('1','1'), 1)
    scenario(probe, external('0','1'), null) // disagreement is not recovery
    scenario(probe, external('0','NaN'), null)
    scenario(probe, external('0','0','100'), null)
    scenario(probe, external('0','0','601'), null)
    const duplicate = external('0','0')
    duplicate['scroll_status_probe_affected{environment="testnet",chain_id="123",component_key="public-rpc",location="a",instance="duplicate"}'] = '0x10'
    scenario(probe, duplicate, null)
    const queue = (count: string, age: string, stamp = '600', valid = '1') => {
      const labels = '{namespace="monitoring",job="withdrawal-processor",instance="writer"}'
      return Object.fromEntries([[`up${labels}`,'1'],[`withdrawal_processor_public_deposit_eligible_backlog${labels}`,count],
        [`withdrawal_processor_public_deposit_oldest_eligible_age_seconds${labels}`,age],
        [`withdrawal_processor_public_deposit_snapshot_timestamp_seconds${labels}`,stamp],
        [`withdrawal_processor_public_deposit_snapshot_valid${labels}`,valid]].map(([key,value]) => [key,Array.from({length: 11}).fill(value).join(' ')]))
    }

    scenario(business, queue('0','0'), 0)
    scenario(business, queue('1','600'), 0)
    scenario(business, queue('1','601'), 1)
    scenario(business, queue('1','601','100'), null)
    scenario(business, queue('1','601','600','0'), null)
    scenario(business, queue('1','NaN'), null)
    scenario(business, queue('-1','0'), null)
    const incomplete = queue('0','0')
    incomplete['up{namespace="monitoring",job="withdrawal-processor",instance="missing-writer"}'] = '1x10'
    scenario(business, incomplete, null)
    const replacement = queue('0','0')
    delete replacement['up{namespace="monitoring",job="withdrawal-processor",instance="writer"}']
    replacement['up{namespace="monitoring",job="withdrawal-processor",instance="replacement"}'] = '1x10'
    scenario(business, replacement, null) // stale gauges cannot stand in for a new live target
    try {
      fs.writeFileSync(path.join(directory, 'queries.yaml'), yaml.dump({evaluation_interval: '1m', tests}))
      execFileSync('docker', ['run','--rm','--user',String(process.getuid?.() ?? 1000),'--entrypoint','promtool','-v',`${directory}:/fixtures:ro`,'prom/prometheus:v2.52.0','test','rules','/fixtures/queries.yaml'], {stdio: 'pipe'})
    } finally { fs.rmSync(directory, {force: true, recursive: true}) }
  }).timeout(180_000)
})
