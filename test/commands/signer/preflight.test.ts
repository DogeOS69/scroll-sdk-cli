import {expect} from 'chai'

import {assertProductionSignerV2Ready} from '../../../src/commands/signer/preflight.js'

const PUBLIC_KEY = `02${'11'.repeat(32)}`
const NETWORK = 'testnet'

function capability(capability: string, productionServing = true): Record<string, unknown> {
  return {
    capability,
    production_block: productionServing ? null : `${capability}_policy_not_configured`,
    production_serving: productionServing,
  }
}

function reports(): {policy: Record<string, unknown>; ready: Record<string, unknown>} {
  const v2Capabilities = [
    capability('advance_l1'),
    capability('advance_l2'),
    capability('rotate_key'),
    capability('rotate_sequencer_signer'),
    capability('advance_l1_pre_tsuki_direct_sign', false),
  ]
  return {
    policy: {
      contract: 'attestation_evidence_v2',
      network: NETWORK,
      policy_mode: 'enforce',
      production_v2_ready: true,
      public_key: PUBLIC_KEY,
      v2_capabilities: v2Capabilities,
    },
    ready: {
      mode: 'enforce',
      production_v2_ready: true,
      v2_capabilities: v2Capabilities,
    },
  }
}

describe('signer preflight production V2 assertion', () => {
  it('accepts exactly the four serving production capabilities while ignoring recovery lanes', () => {
    const {policy, ready} = reports()
    expect(() => assertProductionSignerV2Ready({
      expectedNetwork: NETWORK,
      expectedPublicKey: PUBLIC_KEY,
      policy,
      ready,
      readyStatus: 200,
    })).not.to.throw()
  })

  it('reports fail-closed readiness and the blocked capability', () => {
    const {policy, ready} = reports()
    ready.production_v2_ready = false
    expect(() => assertProductionSignerV2Ready({
      expectedNetwork: NETWORK,
      expectedPublicKey: PUBLIC_KEY,
      policy,
      ready,
      readyStatus: 503,
    })).to.throw('/ready returned HTTP 503')

    const blocked = reports()
    blocked.policy.v2_capabilities = [
      capability('advance_l1'),
      capability('advance_l2', false),
      capability('rotate_key'),
      capability('rotate_sequencer_signer'),
    ]
    expect(() => assertProductionSignerV2Ready({
      expectedNetwork: NETWORK,
      expectedPublicKey: PUBLIC_KEY,
      policy: blocked.policy,
      ready: blocked.ready,
      readyStatus: 200,
    })).to.throw('blocked: advance_l2=advance_l2_policy_not_configured')
  })

  it('rejects observe policy and identity mismatches', () => {
    const scaffold = reports()
    scaffold.policy.policy_mode = 'observe'
    expect(() => assertProductionSignerV2Ready({
      expectedNetwork: NETWORK,
      expectedPublicKey: PUBLIC_KEY,
      policy: scaffold.policy,
      ready: scaffold.ready,
      readyStatus: 200,
    })).to.throw('must both report enforce')

    const mismatch = reports()
    mismatch.policy.public_key = `03${'22'.repeat(32)}`
    expect(() => assertProductionSignerV2Ready({
      expectedNetwork: NETWORK,
      expectedPublicKey: PUBLIC_KEY,
      policy: mismatch.policy,
      ready: mismatch.ready,
      readyStatus: 200,
    })).to.throw('does not match /health')
  })
})
