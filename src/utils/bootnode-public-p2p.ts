/* eslint-disable @typescript-eslint/no-explicit-any -- Helm values are dynamic documents. */
import * as yaml from 'js-yaml'
import {isIP} from 'node:net'

import type {BootnodePublicP2p, DeploymentSpec} from '../types/deployment-spec.js'

import {mergeBootstrapValues} from './spec-bootstrap.js'

/** Validate intent locally. Never allocate EIPs, discover subnets or open a listener. */
export function validateBootnodePublicP2p(entries: BootnodePublicP2p[] | undefined, indices: number[], provider = 'aws'): void {
  if (entries === undefined) return
  if (!Array.isArray(entries)) throw new Error('bootnodePublicP2p must be an array')
  const selected = new Set<number>()
  const allocations = new Set<string>()
  for (const entry of entries) {
    if (!entry || !Number.isSafeInteger(entry.index) || !indices.includes(entry.index) || selected.has(entry.index)) throw new Error('bootnodePublicP2p requires distinct configured bootnode indices')
    selected.add(entry.index)
    if (typeof entry.enabled !== 'boolean') throw new Error('bootnodePublicP2p.enabled must be a boolean')
    if (!entry.enabled) continue
    if (provider !== 'aws') throw new Error('bootnodePublicP2p requires AWS NLB infrastructure')
    if (!Array.isArray(entry.sourceRanges) || entry.sourceRanges.length === 0) throw new Error('bootnodePublicP2p.sourceRanges requires approved partner IPv4 CIDRs')
    for (const cidr of entry.sourceRanges) {
      if (typeof cidr !== 'string') throw new Error('bootnodePublicP2p.sourceRanges must contain IPv4 CIDRs')
      const [address, mask, extra] = cidr.split('/')
      if (isIP(address) !== 4 || !/^(?:[1-9]|[12]\d|3[0-2])$/.test(mask ?? '') || extra !== undefined) throw new Error('bootnodePublicP2p.sourceRanges requires IPv4 CIDRs with prefixes /1 through /32; unrestricted /0 and hostnames are not allowed')
    }

    if (!Array.isArray(entry.subnets) || entry.subnets.length === 0 || entry.subnets.some(value => typeof value !== 'string' || !/^subnet-(?:[\da-f]{8}|[\da-f]{17})$/.test(value)) || new Set(entry.subnets).size !== entry.subnets.length) throw new Error('bootnodePublicP2p.subnets requires distinct AWS subnet IDs')
    if (!Array.isArray(entry.eipAllocations) || entry.eipAllocations.length !== entry.subnets.length) throw new Error('bootnodePublicP2p requires one EIP allocation per subnet, in the same order')
    for (const allocation of entry.eipAllocations) {
      if (typeof allocation !== 'string' || !/^eipalloc-(?:[\da-f]{8}|[\da-f]{17})$/.test(allocation) || allocations.has(allocation)) throw new Error('bootnodePublicP2p EIP allocations must be valid and unique across enabled bootnodes')
      allocations.add(allocation)
    }
  }
}

/** An explicit spec list owns exposure for all bootnodes; absent entries stay private. */
export function applyBootnodePublicP2p(values: any, index: number, entries?: BootnodePublicP2p[]): void {
  if (entries === undefined) return // Preserve the independent manual-values workflow.
  const entry = entries.find(value => value.index === index && value.enabled)
  values.reth ??= {}
  values.reth.p2pExternal = {
    ...values.reth.p2pExternal,
    allowOpenPeering: false,
    eipAllocations: entry?.eipAllocations ?? [],
    enabled: Boolean(entry),
    ordinal: 0,
    sourceRanges: entry?.sourceRanges ?? [],
    subnets: entry?.subnets ?? [],
  }
}

/** Project after merging templates so operator resource tuning is preserved. */
export function projectBootnodePublicP2p(files: Record<string, string>, spec: DeploymentSpec, existing: (file: string) => string | undefined): void {
  const indices = Array.from({length: spec.infrastructure.bootnodeCount}, (_, index) => index)
  validateBootnodePublicP2p(spec.bootnodePublicP2p, indices, spec.infrastructure.provider)
  if (spec.bootnodePublicP2p === undefined) return
  const templateName = 'l2-reth-bootnode-production.yaml'
  const template = files[templateName]
  if (!template) throw new Error('Bootnode public P2P requires a Reth bootnode values template')
  for (const index of indices) {
    const name = `l2-reth-bootnode-production-${index}.yaml`
    const values = yaml.load(mergeBootstrapValues(template.replaceAll('__INSTANCE_INDEX__', String(index)), '{}', existing(name))) as any
    applyBootnodePublicP2p(values, index, spec.bootnodePublicP2p)
    files[name] = yaml.dump(values, {lineWidth: -1, noRefs: true})
  }

  // Never let a shared template expose an unselected node on a later copy.
  const base = yaml.load(template) as any
  applyBootnodePublicP2p(base, -1, [])
  files[templateName] = yaml.dump(base, {lineWidth: -1, noRefs: true})
}
