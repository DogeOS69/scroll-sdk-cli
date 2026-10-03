import {expect} from 'chai'

import {checkSignerNetworks, ipv4CidrsOverlap} from '../../src/utils/signer-network-check.js'

describe('signer Docker network routing preflight', () => {
  it('detects the devnet regression even when the old network has no containers', () => {
    const result = checkSignerNetworks([{IPAM: {Config: [{Subnet: '192.168.32.0/20'}]}, Name: 'stopped-old-signer'}], ['192.168.0.0/16'], '10.253.12.0/24')
    expect(result.conflicts).to.deep.equal([{clusterCidr: '192.168.0.0/16', network: 'stopped-old-signer', subnet: '192.168.32.0/20'}])
    expect(result.proposedConflicts).to.deep.equal([])
  })
  it('detects proposed subnet collisions with cluster and other Docker projects', () => {
    const result = checkSignerNetworks([{IPAM: {Config: [{Subnet: '10.253.12.0/24'}]}, Name: 'another-project'}], ['10.0.0.0/8'], '10.253.12.0/24')
    expect(result.proposedConflicts).to.have.length(2)
  })
  it('handles containment, adjacent ranges, /0 and /32 without signed arithmetic errors', () => {
    expect(ipv4CidrsOverlap('192.168.1.1/32', '192.168.0.0/16')).to.equal(true)
    expect(ipv4CidrsOverlap('10.253.1.0/24', '10.253.2.0/24')).to.equal(false)
    expect(ipv4CidrsOverlap('255.255.255.255/32', '0.0.0.0/0')).to.equal(true)
    expect(() => ipv4CidrsOverlap('10.0.0.1/33', '10.0.0.0/8')).to.throw('IPv4 CIDR')
    expect(() => checkSignerNetworks([], [])).to.throw('at least one')
  })
})
