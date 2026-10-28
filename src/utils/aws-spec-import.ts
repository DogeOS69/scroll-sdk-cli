/* eslint-disable @typescript-eslint/no-explicit-any -- Import only selected public references into operator YAML. */
import * as yaml from 'js-yaml'
import {execFileSync} from 'node:child_process'
import {randomUUID} from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import {isDeepStrictEqual} from 'node:util'

import {privateWrite} from './preparation-io.js'

type Source = {binding?: string; endpoint?: string; file?: string; identity?: string; index?: number; kind: string; stack?: string}
type Change = {conflict: boolean; path: string}
const kinds: Record<string, string[]> = {
  alb: ['endpoint'], 'bootnode-nlb': ['index'], 'capacity-access': [],
  'capacity-alb': [], 'capacity-network': [], 'capacity-target': [], 'http-target': ['binding'],
  'public-network': ['endpoint', 'index'], 'secret-metadata': [], 'secrets-reader': [], 'signing-identities': [], 'signing-key': ['identity', 'index'], 'workload-access': [],
}
const mapping = (v: any): v is Record<string, any> => Boolean(v) && typeof v === 'object' && !Array.isArray(v)
const name = (v: unknown): v is string => typeof v === 'string' && /^[\dA-Za-z][\w-]*$/.test(v)
const placeholder = (v: unknown): boolean => Array.isArray(v) ? v.length > 0 && v.every(value => placeholder(value)) : typeof v === 'string' && (/REPLACE|<[^>]+>|\bTODO\b/.test(v) || v === '')
function loadYaml(text: string): any {
  try {return yaml.load(text)} catch {throw new Error('Invalid YAML input (contents omitted)')}
}

export function parseAwsOutputs(input: unknown): Record<string, string> {
  let value: any = input
  if (mapping(value) && 'Stacks' in value) {
    if (!Array.isArray(value.Stacks) || value.Stacks.length !== 1) throw new Error('Expected exactly one stack per source')
    value = value.Stacks[0]
  }

  if (mapping(value)) {
    if (value.StackStatus && !['CREATE_COMPLETE', 'IMPORT_COMPLETE', 'UPDATE_COMPLETE'].includes(value.StackStatus)) throw new Error('Source stack is not in a successful completed state')
    value = value.Outputs
  }

  if (!Array.isArray(value)) throw new Error('Expected CloudFormation Outputs array or describe-stacks response')
  const outputs: Record<string, string> = Object.create(null)
  for (const row of value) {
    if (!mapping(row) || !name(row.OutputKey) || typeof row.OutputValue !== 'string' || Object.hasOwn(outputs, row.OutputKey)) throw new Error('Invalid or duplicate CloudFormation output')
    outputs[row.OutputKey] = row.OutputValue
  }

  return outputs
}

export function importAwsSpec(options: {manifest: string; profile?: string; readStack?: (stack: string, region: string, profile?: string) => unknown; replace?: boolean; spec: string; write?: boolean}): {backup?: string; changes: Change[]; written: boolean} {
  const specPath = path.resolve(options.spec)
  if (specPath.split(path.sep).includes('.scrollsdk') || fs.lstatSync(specPath).isSymbolicLink() || fs.realpathSync(specPath).split(path.sep).includes('.scrollsdk')) throw new Error('Select an operator-owned spec, not frozen preparation state or a symlink')
  const original = fs.readFileSync(specPath, 'utf8')
  const spec = JSON.parse(JSON.stringify(loadYaml(original)))
  if (!mapping(spec) || spec.version !== '1.0' || !mapping(spec.infrastructure?.aws)) throw new Error('Expected an AWS DeploymentSpec version 1.0')
  const {aws} = spec.infrastructure
  if (typeof aws.accountId !== 'string' || typeof aws.region !== 'string' || !/^\d{12}$/.test(aws.accountId) || !/^[a-z]{2}(?:-[a-z]+)+-\d$/.test(aws.region)) throw new Error('Fill infrastructure.aws.accountId and region before importing')
  const manifestPath = path.resolve(options.manifest)
  const manifest = loadYaml(fs.readFileSync(manifestPath, 'utf8'))
  if (!mapping(manifest) || manifest.version !== 1 || Object.keys(manifest).some(key => !['sources', 'version'].includes(key)) || !Array.isArray(manifest.sources) || manifest.sources.length === 0) throw new Error('Expected an import manifest with version: 1 and nonempty sources')
  const changes: Change[] = []
  const assigned = new Map<string, unknown>()
  const set = (parts: Array<number | string>, value: unknown): void => {
    const label = parts.join('.')
    if (parts.some(part => ['__proto__', 'constructor', 'prototype'].includes(String(part)))) throw new Error('Invalid import destination')
    if (assigned.has(label) && !isDeepStrictEqual(assigned.get(label), value)) throw new Error(`Conflicting sources for ${label}`)
    if (assigned.has(label)) return
    assigned.set(label, value)
    let current = spec
    for (const part of parts.slice(0, -1)) {
      if (current[part] === undefined) current[part] = {}
      if (!mapping(current[part]) && !Array.isArray(current[part])) throw new Error(`Invalid spec structure at ${label}`)
      current = current[part]
    }

    const key = parts.at(-1)!
    if (isDeepStrictEqual(current[key], value)) return
    changes.push({conflict: current[key] !== undefined && !placeholder(current[key]), path: label})
    current[key] = value
  }

  const indexed = (items: unknown, index: number, label: string): number => {
    if (!Array.isArray(items) || items.some(item => !mapping(item))) throw new Error(`Configure ${label} before importing`)
    const matches = items.flatMap((item, i) => item.index === index ? [i] : [])
    if (matches.length !== 1) throw new Error(`Expected exactly one ${label} entry with index ${index}`)
    return matches[0]
  }

  const readStack = options.readStack ?? ((stack: string, region: string, profile?: string): unknown => {
    try {
      return JSON.parse(execFileSync('aws', ['cloudformation', 'describe-stacks', '--stack-name', stack, '--region', region,
        ...(profile ? ['--profile', profile] : []), '--query', 'Stacks[0].{Outputs:Outputs,StackStatus:StackStatus}', '--output', 'json', '--no-cli-pager'],
      {encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000}))
    } catch {throw new Error('Unable to read the selected CloudFormation stack; check account, region, profile and DescribeStacks access')}
  })
  const cache = new Map<string, Record<string, string>>()
  for (const raw of manifest.sources) {
    if (!mapping(raw) || !Object.hasOwn(kinds, raw.kind) || Object.keys(raw).some(key => !['file', 'kind', 'stack', ...kinds[raw.kind]].includes(key))) throw new Error('Invalid source kind or unsupported source field')
    const source = raw as Source
    if (source.stack && placeholder(source.stack)) throw new Error('Replace the example stack name before importing')
    if (Boolean(source.file) === Boolean(source.stack) || source.file !== undefined && typeof source.file !== 'string' || source.stack !== undefined && (typeof source.stack !== 'string' || !/^[A-Za-z][\w-]*$/.test(source.stack))) throw new Error('Each source needs exactly one file path or stack name')
    for (const field of ['endpoint', 'binding', 'identity'] as const) if (source[field] !== undefined && (!name(source[field]) || ['__proto__', 'constructor', 'prototype'].includes(source[field]!))) throw new Error(`Invalid source ${field}`)
    if (source.index !== undefined && (!Number.isSafeInteger(source.index) || source.index < 0)) throw new Error('Invalid source index')
    const cacheKey = source.file ? path.resolve(path.dirname(manifestPath), source.file) : `stack:${source.stack}`
    if (!cache.has(cacheKey)) {
      let value: unknown
      if (source.file) {
        try {value = JSON.parse(fs.readFileSync(cacheKey, 'utf8'))} catch {throw new Error('Cannot read source outputs JSON (contents omitted)')}
      } else value = readStack(source.stack!, aws.region, options.profile)
      cache.set(cacheKey, parseAwsOutputs(value))
    }

    const outputs = cache.get(cacheKey)!
    const get = (key: string, resource?: string): string => {
      const value = outputs[key]
      if (!value || placeholder(value)) throw new Error(`Missing or placeholder ${key} output for ${source.kind}`)
      if (resource) {
        const match = value.match(/^arn:(aws(?:-cn|-us-gov)?):([^:]+):([^:]*):(\d{12}):(.+)$/)
        if (!match || match[4] !== aws.accountId || match[3] && match[3] !== aws.region || `${match[2]}:${match[5]}`.startsWith(resource) === false) throw new Error(`Invalid resource type, account or region for ${key}`)
      }

      return value
    }

    const put = (parts: Array<number | string>, key: string, resource?: string): void => set(parts, get(key, resource))
    const key = (identity: string, output: string, index?: number): void => {
      let base: Array<number | string>
      if (identity === 'bridge') {
        if (spec.preparation?.bridge?.mode !== 'production') throw new Error('Bridge KMS import requires production Bridge intent')
        base = ['preparation', 'bridge', 'production', 'sequencerKms']
      } else if (identity === 'sequencer') base = ['identities', 'sequencers', indexed(spec.identities?.sequencers, index!, 'identities.sequencers'), 'signer']
      else if (['ethDaSubmitter', 'feeOracle'].includes(identity)) base = ['identities', identity]
      else throw new Error('Unsupported signing identity')
      set([...base, 'action'], 'reuse')
      if (identity !== 'bridge') set([...base, 'backend'], 'aws_kms')
      const kms = identity === 'bridge' ? base : [...base, 'kms']
      put([...kms, 'keyId'], output, 'kms:key/')
      set([...kms, 'region'], aws.region)
    }

    const alb = (prefix: string): void => {
      if (!source.endpoint || !mapping(aws.alb?.endpoints?.[source.endpoint])) throw new Error('Configure the named alb.endpoints entry before importing')
      set(['infrastructure', 'aws', 'alb', 'mode'], 'existing')
      const base = ['infrastructure', 'aws', 'alb', 'endpoints', source.endpoint]
      put([...base, 'loadBalancerArn'], `${prefix}LoadBalancerArn`, 'elasticloadbalancing:loadbalancer/app/')
      put([...base, 'listenerArn'], `${prefix}ListenerArn`, 'elasticloadbalancing:listener/app/')
    }

    const nlb = (prefix: string): void => {
      if (source.index === undefined) throw new Error('Bootnode source requires an explicit index')
      const i = indexed(spec.bootnodePublicP2p, source.index, 'bootnodePublicP2p')
      if (spec.bootnodePublicP2p[i].enabled !== true) throw new Error('Enable the selected public bootnode explicitly before importing')
      const base: Array<number | string> = ['bootnodePublicP2p', i]
      set([...base, 'mode'], 'existing')
      put([...base, 'existingNlb', 'targetGroupArn'], `${prefix}TargetGroupArn`, 'elasticloadbalancing:targetgroup/')
      const sg = get(`${prefix}SecurityGroupId`)
      if (!/^sg-(?:[\da-f]{8}|[\da-f]{17})$/.test(sg)) throw new Error('Invalid NLB SecurityGroupId output')
      set([...base, 'existingNlb', 'securityGroupIds'], [sg])
    }

    switch (source.kind) {
      case 'signing-identities': {
        key('ethDaSubmitter', 'EthDaKeyArn'); key('feeOracle', 'FeeOracleKeyArn')
        key('sequencer', 'Sequencer0KeyArn', 0); key('sequencer', 'Sequencer1KeyArn', 1); key('bridge', 'BridgeKeyArn')
        break
      }

      case 'signing-key': { key(source.identity!, 'KeyArn', source.index); break
      }

      case 'workload-access': {
        const associations = ['EthDa', 'FeeOracle', 'ProofCoordinator', 'WithdrawalProcessor', 'Sequencer0', 'Sequencer1'].map(prefix => outputs[`${prefix}RoleAssociationId`])
        if (associations.some(Boolean) && !associations.every(Boolean)) throw new Error('Incomplete workload Pod Identity association outputs')
        set(['infrastructure', 'aws', 'workloadIdentity'], associations.every(Boolean) ? 'pod-identity' : 'irsa')
        for (const [output, field] of Object.entries({EthDaRoleArn: 'ethDaSubmitter', FeeOracleRoleArn: 'feeOracle', ProofCoordinatorRoleArn: 'proofCoordinator', WithdrawalProcessorRoleArn: 'withdrawalProcessor'})) put(['infrastructure', 'aws', 'roles', field], output, 'iam:role/')
        for (const i of [0, 1]) {
          indexed(spec.identities?.sequencers, i, 'identities.sequencers')
          put(['infrastructure', 'aws', 'roles', 'sequencers', String(i)], `Sequencer${i}RoleArn`, 'iam:role/')
        }

        break
      }

      case 'capacity-access': { put(['infrastructure', 'aws', 'roles', 'dstackController'], 'RoleArn', 'iam:role/'); break
      }

      case 'secrets-reader': { put(['infrastructure', 'aws', 'roles', 'externalSecrets'], 'RoleArn', 'iam:role/'); break
      }

      case 'alb': { alb(''); break
      }

      case 'public-network': { alb('Https'); if (source.index !== undefined) nlb('Bootnode'); break
      }

      case 'bootnode-nlb': { nlb(''); break
      }

      case 'http-target': {
        if (!source.binding || !mapping(aws.alb?.bindings?.[source.binding])) throw new Error('Configure the named alb.bindings entry and serviceRef before importing')
        put(['infrastructure', 'aws', 'alb', 'bindings', source.binding, 'targetGroupArn'], 'TargetGroupArn', 'elasticloadbalancing:targetgroup/')
        break
      }

      case 'capacity-target': {
        if (!mapping(spec.capacityManager)) throw new Error('Configure capacityManager intent before importing')
        put(['capacityManager', 'connection', 'existingAlb', 'targetGroupArn'], 'TargetGroupArn', 'elasticloadbalancing:targetgroup/')
        break
      }

      case 'capacity-alb':
      case 'capacity-network': {
        if (!mapping(spec.capacityManager)) throw new Error('Configure capacityManager intent before importing')
        const base = ['capacityManager', 'connection']
        set([...base, 'mode'], 'existing-alb')
        const prefix = source.kind === 'capacity-network' ? 'Https' : ''
        for (const [field, output, resource] of [
          ['loadBalancerArn', `${prefix}LoadBalancerArn`, 'loadbalancer/app/'], ['listenerArn', `${prefix}ListenerArn`, 'listener/app/'],
          ...(source.kind === 'capacity-network' ? [['targetGroupArn', 'ControllerTargetGroupArn', 'targetgroup/']] : []),
        ]) put([...base, 'existingAlb', field], output, `elasticloadbalancing:${resource}`)
        if (outputs[`${prefix}PrivateUrl`]) {
          const url = get(`${prefix}PrivateUrl`)
          if (!/^https:\/\/[\d.A-Za-z-]+$/.test(url)) throw new Error('Invalid HttpsPrivateUrl output')
          set([...base, 'serverUrl'], url)
        } else if (!spec.capacityManager.connection?.serverUrl) throw new Error('Older capacity stack lacks HttpsPrivateUrl; fill capacityManager.connection.serverUrl with its certificate hostname')
        break
      }

      case 'secret-metadata': { put(['preparation', 'proofAws', 'secretName'], 'SecretName'); break
      }
    }
  }

  const conflicts = changes.filter(change => change.conflict)
  if (!options.write || changes.length === 0) return {changes, written: false}
  if (conflicts.length > 0 && !options.replace) throw new Error('Existing values differ; review the preview and use --replace with --write to replace those references')
  if (fs.readFileSync(specPath, 'utf8') !== original) throw new Error('Spec changed during import; retry against the new contents')
  const backup = `${specPath}.${randomUUID()}.bak`
  fs.writeFileSync(backup, original, {flag: 'wx', mode: 0o600})
  privateWrite(specPath, yaml.dump(spec, {lineWidth: -1, noRefs: true}))
  return {backup, changes, written: true}
}
