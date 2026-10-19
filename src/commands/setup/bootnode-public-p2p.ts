/* eslint-disable @typescript-eslint/no-explicit-any -- Helm values and saved configuration are dynamic documents. */
import {Command, Flags} from '@oclif/core'
import * as yaml from 'js-yaml'
import fs from 'node:fs'
import path from 'node:path'
import {isDeepStrictEqual} from 'node:util'
import toml from 'toml'

import type {DeploymentSpec} from '../../types/deployment-spec.js'
import type {DogeConfig} from '../../types/doge-config.js'

import {AwsCliRunner} from '../../utils/aws-cli.js'
import {applyBootnodePublicP2p, bootnodeP2pMode} from '../../utils/bootnode-public-p2p.js'
import {readExistingAlbSpec} from '../../utils/existing-alb.js'
import {existingNlbEntries, publicBootnodeEnodes, verifyExistingNlb} from '../../utils/existing-nlb.js'
import {GenerationTransaction} from '../../utils/generation-transaction.js'

export default class SetupBootnodePublicP2p extends Command {
  static override description = 'Generate selected bootnode P2P bindings from spec and discover public enodes using read-only AWS queries'
  static override examples = [
    '<%= config.bin %> <%= command.id %> --spec ../deployment-spec.yaml --dry-run',
    '<%= config.bin %> <%= command.id %> --spec ../deployment-spec.yaml',
  ]

  static override flags = {
    'aws-profile': Flags.string(),
    dir: Flags.string({default: '.', description: 'Deployment directory; relative paths resolve here'}),
    'doge-config': Flags.string({default: '.data/doge-config.toml', description: 'Existing saved public bootnode identities; never creates keys'}),
    'dry-run': Flags.boolean({default: false, description: 'Validate and show endpoints without writing values'}),
    json: Flags.boolean({default: false}),
    'non-interactive': Flags.boolean({char: 'N', default: false, description: 'Compatibility flag; this command never prompts'}),
    spec: Flags.string({description: 'Editable deployment spec (no implicit saved-intent fallback)', required: true}),
    'values-dir': Flags.string({default: 'values', description: 'Directory containing existing indexed bootnode production values'}),
  }

  async run(): Promise<void> {
    const {flags} = await this.parse(SetupBootnodePublicP2p)
    const root = path.resolve(flags.dir)
    let spec: DeploymentSpec | undefined
    try {spec = readExistingAlbSpec(root, flags.spec)} catch {throw new Error('Cannot read deployment spec (private file contents omitted)')}
    if (!spec) throw new Error('A deployment spec is required')
    const entries = existingNlbEntries(spec)
    if (entries.length === 0 || spec.bootnodePublicP2p?.some(entry => entry.enabled && bootnodeP2pMode(entry) !== 'existing')) throw new Error('Select at least one enabled existing NLB; this command does not create Service-owned load balancers')
    let identities: DogeConfig
    try {identities = toml.parse(fs.readFileSync(path.resolve(root, flags['doge-config']), 'utf8'))} catch {throw new Error('Cannot read saved bootnode identities; configure bootnodes first (private file contents omitted)')}
    getRethBootnodeIndices(identities)
    for (const entry of entries) {
      const identity = identities.bootnodeReth!.instances!.find(instance => instance.index === entry.index)
      if (!identity?.enodeUrl) throw new Error(`Missing saved public identity for bootnode ${entry.index}; configure it first`)
      publicBootnodeEnodes(identity.enodeUrl, [])
    }

    const directory = path.resolve(root, flags['values-dir'])
    // Work in a transaction: all files and AWS resources must pass before any
    // original values are replaced. Concurrent edits abort publication.
    const transaction = GenerationTransaction.begin(directory)
    try {
      const files: Record<string, string> = {}
      const changed: string[] = []
      for (const entry of spec.bootnodePublicP2p!) {
        const filename = `l2-reth-bootnode-production-${entry.index}.yaml`
        const staged = path.join(transaction.stagingRoot, filename)
        if (!fs.existsSync(staged) || !fs.lstatSync(staged).isFile()) throw new Error(`${filename}: an existing regular production values file is required; generate base configuration first`)
        let values: any
        try {values = yaml.load(fs.readFileSync(staged, 'utf8'))} catch {throw new Error(`${filename}: cannot parse production values (private contents omitted)`)}
        if (!values || typeof values !== 'object' || Array.isArray(values) || values.role !== 'bootnode' || !values.reth || typeof values.reth !== 'object' || Array.isArray(values.reth)) throw new Error(`${filename}: expected existing Reth bootnode values`)
        if (values.reth.service?.extra?.p2p?.enabled || (values.reth.p2pExternal?.enabled && values.reth.p2pExternal.mode !== 'existing')) throw new Error(`${filename}: existing Service-owned public P2P requires an explicit migration before binding an independent NLB`)
        const before = structuredClone(values.reth.p2pExternal)
        applyBootnodePublicP2p(values, entry.index, spec.bootnodePublicP2p)
        files[filename] = yaml.dump(values, {lineWidth: -1, noRefs: true})
        if (!isDeepStrictEqual(before, values.reth.p2pExternal)) {
          fs.writeFileSync(staged, files[filename])
          changed.push(path.join(directory, filename))
        }
      }

      const verified = verifyExistingNlb(spec, files, new AwsCliRunner(flags['aws-profile']))
      const endpoints = verified.map(item => ({
        enodes: publicBootnodeEnodes(identities.bootnodeReth!.instances!.find(instance => instance.index === item.entry.index)!.enodeUrl!, item.publicEndpoints),
        index: item.entry.index,
        publicEndpoints: item.publicEndpoints,
        service: item.serviceName,
      }))
      if (!flags['dry-run']) transaction.commit()
      const result = {changedFiles: changed, deployed: false, dryRun: flags['dry-run'], endpoints, verified: true}
      this.log(flags.json ? JSON.stringify(result) : `${flags['dry-run'] ? 'Would update' : 'Updated'} ${changed.length} production values file(s). No AWS resources changed; Helm was not deployed.\n${endpoints.map(item => `bootnode ${item.index}: ${item.enodes.join(', ')}`).join('\n')}\nPartner allowlists remain in AWS security groups. Run setup nlb --require-targets after Helm deployment; TCP health alone does not verify P2P identity or block sync.`)
    } finally {transaction.rollback()}
  }
}

export function getRethBootnodeIndices(config: DogeConfig): number[] {
  const indices = config.bootnodeReth?.instances?.map(instance => instance.index) || []
  if (indices.length === 0 || indices.some(index => !Number.isSafeInteger(index) || index < 0) || new Set(indices).size !== indices.length) {
    throw new Error('Configure unique Reth bootnode indices with setup l2-bootnode-reth before exposing public P2P services.')
  }

  return indices.sort((a, b) => a - b)
}
