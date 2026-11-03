import {expect} from 'chai'

import {reconcileMonitoringStatusPage} from '../../src/utils/monitoring-status-page.js'

// Provider state and policy belong to the deployment; the spec owns only intent.
describe('status-page spec intent', () => {
  it('preserves bindings and publication policy across repeated projections', () => {
    const values = {statusPage: {enabled: false, environment: '', generated: undefined, instatus: {componentIds: {'public-rpc': 'component-1'}, pageId: 'page-1'}, publication: {components: {'public-rpc': {mode: 'observe'}}}}}
    const original = structuredClone(values.statusPage)
    const config = {environment: 'testnet' as const, statusPage: {enabled: true}}
    expect(reconcileMonitoringStatusPage(values, config)).length(1)
    expect(values.statusPage.instatus).deep.eq(original.instatus)
    expect(values.statusPage.publication).deep.eq(original.publication)
    expect(reconcileMonitoringStatusPage(values, config)).deep.eq([])
  })

  it('honors opt-out and leaves undeclared intent unchanged', () => {
    const values = {statusPage: {enabled: true, environment: 'mainnet'}}
    expect(reconcileMonitoringStatusPage(values)).deep.eq([])
    reconcileMonitoringStatusPage(values, {environment: 'testnet', statusPage: {enabled: false}})
    expect(values.statusPage).deep.eq({enabled: false, environment: 'testnet'})
  })

  it('rejects disabling or retargeting an existing publication without mutation', () => {
    const values = {statusPage: {enabled: true, environment: 'testnet', generated: {environment: 'testnet'}, instatus: {pageId: 'page-1'}}}
    const original = structuredClone(values)
    expect(() => reconcileMonitoringStatusPage(values, {environment: 'testnet', statusPage: {enabled: false}})).throw('before disabling')
    expect(() => reconcileMonitoringStatusPage(values, {environment: 'mainnet', statusPage: {enabled: true}})).throw('environment changed')
    expect(values).deep.eq(original)
  })
})
