/* eslint-disable @typescript-eslint/no-explicit-any -- Validated deployment values. */

/** Private collector configuration, never included in the public Instatus catalog. */
export function normalizeNodeSync(input: any = {}, chainId: string, environment: string, health: any, read?: (filename: string) => any): {config: any; inputs: any} {
  const defaults = {followers: [], image: 'python:3.12.11-alpine3.22', mode: 'external', namespace: '', reference: {}}
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !(key in defaults))) throw new Error('Invalid publication.nodeSync configuration')
  const inputs = {...defaults, ...input}
  if (!['external', 'official'].includes(inputs.mode)) throw new Error('nodeSync.mode must be official or external')
  const dns = (value: unknown) => typeof value === 'string' && value.length <= 63 && /^[\da-z](?:[\da-z-]*[\da-z])?$/.test(value)
  if (inputs.namespace !== '' && !dns(inputs.namespace)) throw new Error('Invalid nodeSync namespace')
  if (typeof inputs.image !== 'string' || !inputs.image || /\s/.test(inputs.image)) throw new Error('Invalid nodeSync image')
  if (!Array.isArray(inputs.followers)) throw new Error('nodeSync.followers must be a list')
  if (inputs.mode === 'external') {
    if ((!inputs.reference || typeof inputs.reference !== 'object' || Object.keys(inputs.reference).length > 0) || inputs.followers.length > 0) throw new Error('External Node Sync must not retain official node sources')
    return {config: null, inputs}
  }

  if (!read) throw new Error('Official Node Sync requires deployment values sources')
  const resolve = (entry: any, reference: boolean) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) || Object.keys(entry).some(key => !['release', 'role', 'service', 'values'].includes(key))) throw new Error('Node source requires values, release and role; optional explicit service override')
    if (!dns(entry.release) || typeof entry.values !== 'string' || !entry.values || !['bootnode', 'internal-rpc', 'public-rpc', 'sequencer'].includes(entry.role) || (reference !== (entry.role === 'sequencer'))) throw new Error('Invalid Node Sync source role/release/values')
    const values = read(entry.values)
    const role = reference ? 'sequencer' : entry.role === 'bootnode' ? 'bootnode' : 'rpc'
    if (values.role !== role) throw new Error('Node Sync source role does not match selected values')
    if (String(values.reth?.networkId) !== chainId && (!/^(?:\d+|0x[\da-f]+)$/i.test(String(values.reth?.networkId)) || BigInt(values.reth.networkId) !== BigInt(chainId))) throw new Error('Node Sync source networkId must match this chain')
    if (reference ? values.reth?.sequencer?.enabled !== true || values.reth?.sequencer?.allowEmptyBlocks !== true : values.reth?.sequencer?.enabled === true) throw new Error('Node Sync requires an active continuously producing reference and non-sequencer followers')
    const replicas = values.controller?.replicas ?? 1
    if (!Number.isInteger(replicas) || replicas < 0 || replicas > 32 || (reference && replicas !== 1)) throw new Error('Node Sync requires one active reference and 0..32 replicas per follower source')
    if (values.controller?.enabled === false) throw new Error('Node Sync source controller is disabled; remove the source')
    const port = values.reth?.ports?.http ?? 8545
    if (!Number.isInteger(port) || port < 1 || port > 65_535 || values.reth?.http?.enabled === false || values.service?.main?.enabled === false) throw new Error('Node Sync requires an enabled internal HTTP RPC Service')
    const name = String(values.global?.nameOverride || values.nameOverride || 'l2-reth').slice(0, 63).replace(/-$/, '')
    const fullname = String(values.global?.fullnameOverride || values.fullnameOverride || (entry.release.includes(name) ? entry.release : `${entry.release}-${name}`)).slice(0, 63).replace(/-$/, '')
    const main = values.service?.main ?? {}
    const service = entry.service ?? (main.fullname || `${fullname}${main.nameOverride ? `-${main.nameOverride}` : ''}`)
    if (!dns(service)) throw new Error('Node Sync Service name must be explicit for templated/custom service names')
    return {port, replicas, role: entry.role, service}
  }

  const reference = resolve(inputs.reference, true)
  const followers = inputs.followers.map((entry: any) => resolve(entry, false)).filter((entry: any) => entry.replicas > 0)
  if (followers.length === 0 || followers.reduce((sum: number, entry: any) => sum + entry.replicas, 0) > 32) throw new Error('Node Sync requires 1..32 enabled follower Pods')
  const names = [reference, ...followers].map(entry => entry.service)
  if (new Set(names).size !== names.length) throw new Error('Node Sync sources must select distinct Services')
  return {config: {chainId, environment, followers, maxBlockAgeSeconds: health.maxBlockAgeSeconds, maxNodeLagSeconds: health.maxNodeLagSeconds, reference}, inputs}
}
