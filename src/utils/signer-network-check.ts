import {isIP} from 'node:net'

export interface DockerNetwork {IPAM?: {Config?: Array<{Subnet?: string}>}; Id?: string; Name?: string}

function ipv4Range(cidr: string): [number, number] {
  const parts = cidr.split('/')
  const bits = Number(parts[1])
  if (parts.length !== 2 || isIP(parts[0]) !== 4 || !/^\d+$/.test(parts[1]) || bits < 0 || bits > 32) throw new Error(`Expected IPv4 CIDR, got ${cidr}`)
  const address = parts[0].split('.').reduce((value, octet) => value * 256 + Number(octet), 0)
  const size = 2 ** (32 - bits)
  const start = Math.floor(address / size) * size
  return [start, start + size - 1]
}

export function ipv4CidrsOverlap(left: string, right: string): boolean {
  const [a, b] = ipv4Range(left)
  const [c, d] = ipv4Range(right)
  return a <= d && c <= b
}

export function checkSignerNetworks(networks: DockerNetwork[], clusterCidrs: string[], proposedSubnet?: string): {
  conflicts: Array<{clusterCidr: string; network: string; subnet: string}>
  proposedConflicts: string[]
} {
  if (clusterCidrs.length === 0) throw new Error('Supply at least one VPC/pod/service --cluster-cidr')
  clusterCidrs.forEach(cidr => ipv4Range(cidr))
  if (proposedSubnet) ipv4Range(proposedSubnet)
  const conflicts: Array<{clusterCidr: string; network: string; subnet: string}> = []
  const proposedConflicts: string[] = []
  for (const network of networks) {
    for (const entry of network.IPAM?.Config ?? []) {
      if (!entry.Subnet) continue
      if (isIP(entry.Subnet.split('/')[0]) === 6) continue // This command explicitly checks IPv4 only.
      for (const clusterCidr of clusterCidrs) {
        if (ipv4CidrsOverlap(entry.Subnet, clusterCidr)) conflicts.push({clusterCidr, network: network.Name ?? network.Id ?? 'unnamed', subnet: entry.Subnet})
      }

      if (proposedSubnet && ipv4CidrsOverlap(entry.Subnet, proposedSubnet)) proposedConflicts.push(`Docker network ${network.Name ?? network.Id}: ${entry.Subnet}`)
    }
  }

  if (proposedSubnet) for (const cidr of clusterCidrs) if (ipv4CidrsOverlap(proposedSubnet, cidr)) proposedConflicts.push(`Cluster ${cidr}`)
  return {conflicts, proposedConflicts}
}
