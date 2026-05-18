import { expect } from 'chai'

import {
  BRIDGE_TIMELOCK_MARGIN_BLOCKS,
  BRIDGE_TIMELOCK_RELATIVE_BLOCKS,
  resolveBridgeTimelock,
} from '../../../src/commands/setup/bridge-init.js'

describe('setup bridge-init timelock resolution', () => {
  const currentHeight = 50_579_598
  const desiredTimelock = currentHeight + BRIDGE_TIMELOCK_RELATIVE_BLOCKS + BRIDGE_TIMELOCK_MARGIN_BLOCKS

  it('rewrites the template placeholder to a future Dogecoin absolute height', () => {
    const result = resolveBridgeTimelock(100, currentHeight)

    expect(result).to.deep.equal({
      reason: 'placeholder',
      shouldUpdate: true,
      timelock: desiredTimelock,
    })
  })

  it('keeps an existing future Dogecoin absolute height for idempotent reruns', () => {
    const result = resolveBridgeTimelock(50_838_898, currentHeight)

    expect(result).to.deep.equal({
      shouldUpdate: false,
      timelock: 50_838_898,
    })
  })

  it('rewrites an expired timelock', () => {
    const result = resolveBridgeTimelock(currentHeight, currentHeight)

    expect(result).to.deep.equal({
      reason: 'expired',
      shouldUpdate: true,
      timelock: desiredTimelock,
    })
  })

  it('rejects timestamp-semantics timelocks', () => {
    expect(() => resolveBridgeTimelock(500_000_000, currentHeight)).to.throw(
      'Existing timelock 500000000 is not a Dogecoin block-height CLTV value'
    )
  })
})
