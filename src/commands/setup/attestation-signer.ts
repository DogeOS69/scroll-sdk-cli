/* eslint-disable @typescript-eslint/no-explicit-any -- TOML exposes dynamic values */
import * as toml from '@iarna/toml'
import { Command, Flags } from '@oclif/core'
import chalk from 'chalk'
import fs from 'node:fs'
import path from 'node:path'

import type { AttestationSignerDescriptor } from '../../utils/attestation-signer-descriptor.js'

import { getSetupDefaultsPath } from '../../config/constants.js'
import { fetchSignerHealth, loadAttestationSignerDescriptor } from '../../utils/attestation-signer-descriptor.js'
import { dogeConfigToToml, loadDogeConfigWithSelection } from '../../utils/doge-config.js'
import { JsonOutputContext } from '../../utils/json-output.js'

function csv(value: string | undefined): string[] {
  return value?.split(',').map(item => item.trim()).filter(Boolean) || []
}

function positiveInteger(raw: string | undefined, fallback: number, name: string): number {
  const value = raw === undefined ? fallback : Number(raw)
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`)
  return value
}

export class AttestationSignerCommand extends Command {
  static description = 'Import partner-operated attestation-signer descriptors and select the bootstrap bridge keyset. Signers are deployed by their operators (see `scrollsdk signer init` / `scrollsdk signer preflight`); this command only consumes descriptor files — endpoint + public key — and never provisions keys or Kubernetes releases.'

  static examples = [
    '$ scrollsdk setup attestation-signer --threshold 2 --probe',
    '$ scrollsdk setup attestation-signer --descriptor partner-a.json --descriptor partner-b.json --descriptor ours.json --threshold 2',
    '$ scrollsdk setup attestation-signer --descriptor-dir descriptors/ --threshold 3 --active-signer-ids partner-a,partner-b,ours-0',
  ]

  static flags = {
    'active-signer-ids': Flags.string({ description: 'Comma-separated signer IDs entering initial bridge setup (default: every imported descriptor)' }),
    config: Flags.string({ char: 'c', description: 'Path to doge-config.toml' }),
    descriptor: Flags.string({ description: 'attestation-signer-descriptor JSON file; repeat per signer', multiple: true }),
    'descriptor-dir': Flags.string({ description: 'Directory whose *.json files are all loaded as descriptors (default: descriptors/ when it exists and no --descriptor is given)' }),
    json: Flags.boolean({ default: false, description: 'Output structured JSON' }),
    probe: Flags.boolean({ default: false, description: 'GET each signer /health and require the runtime public key to match the descriptor before accepting it' }),
    threshold: Flags.string({ description: 'Initial bridge attestation threshold (T of the active set)' }),
  }

  async run(): Promise<void> {
    const { flags } = await this.parse(AttestationSignerCommand)
    const json = new JsonOutputContext('setup attestation-signer', flags.json)
    try {
      const descriptors = this.loadDescriptors(flags)
      const loaded = await loadDogeConfigWithSelection(flags.config, 'scrollsdk setup doge-config')
      const { config } = loaded

      for (const descriptor of descriptors) {
        if (descriptor.network !== config.network) {
          throw new Error(`descriptor ${descriptor.id} is for network ${descriptor.network}, but doge-config network is ${config.network}`)
        }
      }

      if (flags.probe) await this.probeDescriptors(descriptors, json)

      const byId = new Map(descriptors.map(descriptor => [descriptor.id, descriptor]))
      const requestedActive = csv(flags['active-signer-ids'])
      const activeSignerIds = requestedActive.length > 0 ? requestedActive : descriptors.map(descriptor => descriptor.id)
      if (new Set(activeSignerIds).size !== activeSignerIds.length || activeSignerIds.some(id => !byId.has(id))) {
        throw new Error('active-signer-ids must be unique members of the imported descriptor set')
      }

      const threshold = positiveInteger(flags.threshold, config.attestationSigner?.threshold || Math.ceil(activeSignerIds.length * 2 / 3), 'threshold')
      if (threshold > activeSignerIds.length) throw new Error('threshold cannot exceed the initial active signer count')

      config.attestationSigner = {
        activeSignerIds,
        external: descriptors.map(descriptor => ({
          endpoint: descriptor.endpoint,
          id: descriptor.id,
          publicKey: descriptor.publicKey,
        })),
        mode: 'external',
        threshold,
      }
      config.signerUrls = activeSignerIds.map(id => byId.get(id)!.endpoint)
      fs.writeFileSync(loaded.configPath, dogeConfigToToml(config))
      this.writeInitialBridgeConfig(descriptors, activeSignerIds, threshold)

      const result = {
        activeSignerIds,
        signerCount: descriptors.length,
        signerUrls: config.signerUrls,
        signers: config.attestationSigner.external,
        threshold,
      }
      if (flags.json) json.success(result)
      else this.log(chalk.green(`Imported ${descriptors.length} external signer descriptors; bridge init will use ${activeSignerIds.join(', ')} at threshold ${threshold}.`))
    } catch (error) {
      json.error('E801_ATTESTATION_SIGNER_IMPORT_FAILED', error instanceof Error ? error.message : String(error), 'CONFIGURATION', true)
    }
  }

  private loadDescriptors(flags: { descriptor?: string[]; 'descriptor-dir'?: string }): AttestationSignerDescriptor[] {
    const files = (flags.descriptor || []).map(item => path.resolve(item))
    // Conventional working-directory layout: collected descriptors live in
    // descriptors/, so an explicit flag is only needed for other layouts.
    const defaultDir = path.resolve('descriptors')
    const descriptorDir = flags['descriptor-dir']
      ?? (files.length === 0 && fs.existsSync(defaultDir) && fs.statSync(defaultDir).isDirectory() ? defaultDir : undefined)
    if (descriptorDir) {
      const dir = path.resolve(descriptorDir)
      if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new Error(`--descriptor-dir ${dir} is not a directory`)
      files.push(...fs.readdirSync(dir).filter(name => name.endsWith('.json')).sort().map(name => path.join(dir, name)))
    }

    if (files.length === 0) {
      throw new Error(descriptorDir
        ? `no descriptor *.json files found in ${descriptorDir}`
        : 'Provide at least one signer via --descriptor or --descriptor-dir (no descriptors/ directory found in the working directory)')
    }

    const descriptors = files.map(file => loadAttestationSignerDescriptor(file))
    const ids = new Set<string>()
    const pubkeys = new Set<string>()
    const endpoints = new Set<string>()
    for (const descriptor of descriptors) {
      if (ids.has(descriptor.id)) throw new Error(`duplicate signer id across descriptors: ${descriptor.id}`)
      if (pubkeys.has(descriptor.publicKey)) throw new Error(`duplicate publicKey across descriptors (${descriptor.id}); every signer must hold its own key`)
      if (endpoints.has(descriptor.endpoint)) throw new Error(`duplicate endpoint across descriptors (${descriptor.id}); every signer must be independently reachable`)
      ids.add(descriptor.id)
      pubkeys.add(descriptor.publicKey)
      endpoints.add(descriptor.endpoint)
    }

    return descriptors
  }

  private async probeDescriptors(descriptors: AttestationSignerDescriptor[], json: JsonOutputContext): Promise<void> {
    for (const descriptor of descriptors) {
      const health = await fetchSignerHealth(descriptor.endpoint)
      if (health.publicKey !== descriptor.publicKey) {
        throw new Error(`${descriptor.id}: /health public key ${health.publicKey} does not match descriptor publicKey ${descriptor.publicKey}`)
      }

      if (health.network && health.network !== descriptor.network) {
        throw new Error(`${descriptor.id}: /health network ${health.network} does not match descriptor network ${descriptor.network}`)
      }

      json.logSuccess(`Probed ${descriptor.id} at ${descriptor.endpoint}: public key matches`)
    }
  }

  private writeInitialBridgeConfig(descriptors: AttestationSignerDescriptor[], activeIds: string[], threshold: number): void {
    const file = getSetupDefaultsPath()
    if (!fs.existsSync(file)) throw new Error('setup_defaults.toml not found; run scrollsdk setup doge-config first')
    const data = toml.parse(fs.readFileSync(file, 'utf8')) as any
    const byId = new Map(descriptors.map(descriptor => [descriptor.id, descriptor]))
    const pubkeys = activeIds.map(id => byId.get(id)!.publicKey)
    data.attestation_pubkeys = pubkeys
    data.attestation_key_count = pubkeys.length
    data.attestation_threshold = threshold
    fs.writeFileSync(file, toml.stringify(data))
  }
}

export default AttestationSignerCommand
