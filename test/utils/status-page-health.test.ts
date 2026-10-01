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
    const health = normalizeHealth({batchPublicationDeadlineSeconds: 300, depositDeadlineSeconds: 600, wfStallSeconds: 300, withdrawalDeadlineSeconds: 900})
    const probe = builtinHealth('public-rpc', 'testnet', '123', health)
    const business = builtinHealth('deposits', 'testnet', '123', health)
    const tests: any[] = []
    const scenario = (expr: string, series: Record<string, string>, expected: null | number) => tests.push({input_series: Object.entries(series).map(([series, values]) => ({series, values})), interval: '1m', name: `scenario-${tests.length + 1}`,
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
    const official = builtinHealth('node-sync', 'testnet', '123', health, 'official')
    const nodes = (value: string, stamp = '600'): Record<string, string> => {
      const labels = '{environment="testnet",chain_id="123",component_key="node-sync",instance="collector"}'
      return {[`scroll_status_node_sync_affected${labels}`]: Array.from({length: 11}).fill(value).join(' '), [`scroll_status_node_sync_timestamp_seconds${labels}`]: `${stamp}x10`}
    }

    scenario(official, nodes('0'), 0)
    scenario(official, nodes('1'), 1)
    scenario(official, nodes('2'), null)
    scenario(official, nodes('NaN'), null)
    scenario(official, nodes('0', '479'), null)
    scenario(official, nodes('0', '601'), null)
    scenario(official, {}, null)
    const noTimestamp = nodes('0')
    delete noTimestamp[Object.keys(noTimestamp).find(key => key.includes('timestamp'))!]
    scenario(official, noTimestamp, null)
    const duplicateCollector = nodes('0')
    for (const [key, value] of Object.entries(nodes('0'))) duplicateCollector[key.replace('instance="collector"', 'instance="replacement"')] = value
    scenario(official, duplicateCollector, null)
    const queue = (count: string, age: string, stamp = '600', valid = '1') => {
      const labels = '{namespace="monitoring",job="withdrawal-processor",instance="writer"}'
      return Object.fromEntries([[`up${labels}`,'1'],[`withdrawal_processor_public_deposit_eligible_backlog${labels}`,count],
        [`withdrawal_processor_public_deposit_oldest_eligible_age_seconds${labels}`,age],
        [`withdrawal_processor_public_deposit_snapshot_timestamp_seconds${labels}`,stamp],
        [`withdrawal_processor_public_deposit_snapshot_valid${labels}`,valid],
        [`withdrawal_processor_public_workflow_snapshot_valid${labels}`,'1'],
        [`withdrawal_processor_public_workflow_snapshot_timestamp_seconds${labels}`,'600'],
        [`withdrawal_processor_public_workflow_head_observed_timestamp_seconds${labels}`,'1'],
        [`withdrawal_processor_public_workflow_unchanged_seconds${labels}`,'599'],
        ['withdrawal_processor_protocol_snapshot_valid{namespace="monitoring",job="withdrawal-processor",instance="writer",source="jobs"}','1'],
        ['withdrawal_processor_protocol_snapshot_timestamp_seconds{namespace="monitoring",job="withdrawal-processor",instance="writer",source="jobs"}','600'],
        ['withdrawal_processor_protocol_job_oldest_age_seconds{namespace="monitoring",job="withdrawal-processor",instance="writer",status="built",action_kind="advance_l2_build"}','0']].map(([key,value]) => [key,Array.from({length: 11}).fill(value).join(' ')]))
    }

    scenario(business, queue('0','0'), 0)
    scenario(business, queue('1','600'), 0)
    scenario(business, queue('1','601'), 1)
    scenario(business, queue('1','601','100'), null)
    scenario(business, queue('1','601','600','0'), null)
    scenario(business, queue('1','NaN'), null)
    scenario(business, queue('-1','0'), null)
    // Confirmed WF failure must publish even with missing/invalid business observations.
    const unchanged = 'withdrawal_processor_public_workflow_unchanged_seconds{namespace="monitoring",job="withdrawal-processor",instance="writer"}'
    const wfHead = 'withdrawal_processor_public_workflow_head_observed_timestamp_seconds{namespace="monitoring",job="withdrawal-processor",instance="writer"}'
    const wfAge = 'withdrawal_processor_protocol_job_oldest_age_seconds{namespace="monitoring",job="withdrawal-processor",instance="writer",status="built",action_kind="advance_l2_build"}'
    const stalled = {...queue('0','0','600','0'), [wfAge]: '601x10'}
    scenario(business, stalled, 1)
    scenario(builtinHealth('withdrawals', 'testnet', '123', health), stalled, 1)
    const noBusiness = Object.fromEntries(Object.entries(stalled).filter(([key]) => !key.includes('_public_deposit_')))
    scenario(business, noBusiness, 1)
    scenario(business, {...noBusiness, [wfAge]: '0x10'}, null) // no false recovery
    scenario(business, {...queue('0','0'), [unchanged]: '0x10', [wfAge]: '601x10', [wfHead]: '590x10'}, 0) // progress
    scenario(business, {...queue('0','0'), [wfAge]: '300x10'}, 0) // below stall deadline
    scenario(business, {...queue('0','0'), [wfAge]: Array.from({length: 11}).fill('NaN').join(' ')}, null)
    scenario(business, {...queue('0','0'), [unchanged]: '0x10', [wfHead]: '_ _ _ _ _ _ 590x4'}, 0) // recent persisted head needs no Pod history
    scenario(business, {...stalled, [wfHead]: '0x10'}, null) // invalid persisted head timestamp
    const workflowValid = 'withdrawal_processor_public_workflow_snapshot_valid{namespace="monitoring",job="withdrawal-processor",instance="writer"}'
    scenario(business, {...queue('0','0'), [unchanged]: '0x10'}, 0) // restart + idle: known immediately
    scenario(business, {...queue('0','0'), [unchanged]: '0x10', [wfAge]: '601x10'}, null) // old overdue work needs continuity
    scenario(business, {...queue('0','0'), [unchanged]: '0x10', [wfAge]: '601x10', [wfHead]: '590x10'}, 0) // recent progress survives restart
    scenario(business, {...queue('0','0'), [workflowValid]: '0x10'}, null) // consistency guard invalidates recovery
    scenario(business, {...queue('0','0'), [wfHead]: '601x10'}, null) // clock anomaly
    scenario(business, {...queue('0','0'), [unchanged]: Array.from({length: 11}).fill('NaN').join(' ')}, null)
    const noWorkflow = Object.fromEntries(Object.entries(queue('0','0')).filter(([key]) => !key.includes('_protocol_') && !key.includes('_public_workflow_')))
    scenario(business, noWorkflow, null)
    const businessFailure = Object.fromEntries(Object.entries(queue('1','601')).filter(([key]) => !key.includes('_protocol_') && !key.includes('_public_workflow_')))
    scenario(business, businessFailure, 1) // independent failure is still actionable
    const incomplete = queue('0','0')
    incomplete['up{namespace="monitoring",job="withdrawal-processor",instance="missing-writer"}'] = '1x10'
    scenario(business, incomplete, null)
    const replacement = queue('0','0')
    delete replacement['up{namespace="monitoring",job="withdrawal-processor",instance="writer"}']
    replacement['up{namespace="monitoring",job="withdrawal-processor",instance="replacement"}'] = '1x10'
    scenario(business, replacement, null) // stale gauges cannot stand in for a new live target
    try {
      fs.writeFileSync(path.join(directory, 'queries.yaml'), yaml.dump({evaluation_interval: '1m', tests}))
      execFileSync('docker', ['run','--rm','--user',String(process.getuid?.() ?? 1000),'--entrypoint','promtool','-v',`${directory}:/fixtures:ro`,'prom/prometheus:v2.52.0','test','rules','/fixtures/queries.yaml'], {stdio: 'pipe', timeout: 120_000})
    } finally { fs.rmSync(directory, {force: true, recursive: true}) }
  }).timeout(180_000)
})
