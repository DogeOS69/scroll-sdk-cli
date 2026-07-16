/* eslint-disable @typescript-eslint/no-explicit-any -- TOML and JSON artifacts expose dynamic values */
import * as toml from '@iarna/toml'
import { Command, Flags } from '@oclif/core'
import chalk from 'chalk'
import fs from 'node:fs'
import path from 'node:path'

import { loadDogeConfigWithSelection } from '../../utils/doge-config.js'
import { JsonOutputContext } from '../../utils/json-output.js'

function require20ByteHex(value: string, name: string): string {
  const normalized = value.toLowerCase().startsWith('0x') ? value.toLowerCase() : `0x${value.toLowerCase()}`
  if (!/^0x[\da-f]{40}$/.test(normalized)) throw new Error(`${name} must be 20-byte hex (0x + 40 hex chars)`)
  return normalized
}

function require32ByteHex(value: string, name: string): string {
  const normalized = value.toLowerCase().startsWith('0x') ? value.toLowerCase() : `0x${value.toLowerCase()}`
  if (!/^0x[\da-f]{64}$/.test(normalized)) throw new Error(`${name} must be 32-byte hex (0x + 64 hex chars)`)
  return normalized
}

/**
 * The post-genesis half of the partner-signer handshake: after descriptors
 * were imported (`setup attestation-signer`) and the bridge was generated
 * (`setup bridge-init`), this command assembles the policy bundle every
 * signer operator needs to switch their attestation-signer into the
 * production profile. The bundle is chain-level (identical for every signer
 * of this bridge) — the only per-operator value is the signer's own key,
 * which the operator already holds.
 */
export class ExportSignerPolicyCommand extends Command {
  static description = 'Assemble the post-genesis policy bundle for partner-operated attestation signers (active bridge key hash, protocol/bridge identity, verifier registry, source set, envelope policy). Send the bundle directory to every signer operator; they apply it and restart into the production profile.'

  static examples = [
    '$ scrollsdk setup export-signer-policy --protocol-instance-id 0x... --tso-url https://tso.dogeos.example --signer-proof-artifact-base-url https://proofs.dogeos.example/proof-topology',
    '$ scrollsdk setup export-signer-policy --protocol-instance-id 0x... --tso-url https://tso.dogeos.example --signer-proof-artifact-base-url https://proofs.dogeos.example --allowed-proof-triples "scroll_batch:scroll-production-v1:<vk-hash>"',
  ]

  static flags = {
    'allowed-proof-triples': Flags.string({ default: '', description: 'Envelope proof-triple allowlist (same format setup proof-config projects); leave empty until proof topology is staged' }),
    'bridge-namespace-id': Flags.string({ description: '20-byte bridge namespace id; default is read from .data/GenerateBridgeInfo.toml (namespace_id) written by bridge-init step 3' }),
    config: Flags.string({ char: 'c', description: 'Path to doge-config.toml' }),
    json: Flags.boolean({ default: false, description: 'Output structured JSON' }),
    out: Flags.string({ default: 'signer-policy-bundle', description: 'Bundle output directory' }),
    'protocol-context': Flags.string({ default: '.data/protocol_context.json', description: 'protocol_context.json produced by setup bridge-init step 5' }),
    'protocol-instance-id': Flags.string({ description: '32-byte protocol instance id (genesis-state hash of this deployment)', required: true }),
    'signer-proof-artifact-base-url': Flags.string({ description: 'Stable public GET base signers use to fetch accepted proof objects', required: true }),
    'source-set': Flags.string({ default: 'configs/source-set.toml', description: 'source-set.toml to include in the bundle' }),
    'supported-signing-policy-versions': Flags.string({ default: '1', description: 'CSV of supported signing policy versions' }),
    'tee-allowed-signer-ids': Flags.string({ default: '', description: 'CSV of allowed TEE signer ids (compressed secp256k1 pubkeys)' }),
    'tso-url': Flags.string({ description: 'TSO base URL reachable FROM the signer operator network (used for signature callbacks)', required: true }),
    'verifier-registry': Flags.string({ default: 'configs/verifier-registry.toml', description: 'verifier-registry.toml to include in the bundle' }),
  }

  async run(): Promise<void> {
    const { flags } = await this.parse(ExportSignerPolicyCommand)
    const json = new JsonOutputContext('setup export-signer-policy', flags.json)
    try {
      const loaded = await loadDogeConfigWithSelection(flags.config, 'scrollsdk setup doge-config')
      const { config } = loaded
      const external = config.attestationSigner?.external
      if (!external || external.length === 0 || config.attestationSigner?.mode !== 'external') {
        throw new Error('doge-config has no external attestation signers; run scrollsdk setup attestation-signer with descriptors first')
      }

      const contextPath = path.resolve(flags['protocol-context'])
      if (!fs.existsSync(contextPath)) throw new Error(`${contextPath} not found; run scrollsdk setup bridge-init first`)
      const protocolContext = JSON.parse(fs.readFileSync(contextPath, 'utf8'))
      const activeBridgeKeyHash = require20ByteHex(
        String(protocolContext?.genesis?.genesis_bridge_key_hash || ''),
        'protocol_context.json genesis.genesis_bridge_key_hash'
      )

      const bridgeNamespaceId = require20ByteHex(
        flags['bridge-namespace-id'] || this.readNamespaceIdFromGenerateBridgeInfo(),
        'bridge namespace id'
      )
      const protocolInstanceId = require32ByteHex(flags['protocol-instance-id'], '--protocol-instance-id')

      const verifierRegistryPath = path.resolve(flags['verifier-registry'])
      const sourceSetPath = path.resolve(flags['source-set'])
      for (const [file, name] of [[verifierRegistryPath, '--verifier-registry'], [sourceSetPath, '--source-set']] as const) {
        if (!fs.existsSync(file)) throw new Error(`${name} file not found: ${file}`)
      }

      const outDir = path.resolve(flags.out)
      fs.mkdirSync(outDir, { recursive: true })
      fs.copyFileSync(verifierRegistryPath, path.join(outDir, 'verifier-registry.toml'))
      fs.copyFileSync(sourceSetPath, path.join(outDir, 'source-set.toml'))

      const policy = {
        activeBridgeKeyHash,
        allowedProofTriples: flags['allowed-proof-triples'],
        bridgeNamespaceId,
        network: config.network,
        protocolInstanceId,
        signerProofArtifactBaseUrl: flags['signer-proof-artifact-base-url'],
        signers: external.map(signer => ({ endpoint: signer.endpoint, id: signer.id, publicKey: signer.publicKey })),
        supportedSigningPolicyVersions: flags['supported-signing-policy-versions'],
        teeAllowedSignerIds: flags['tee-allowed-signer-ids'],
        tsoUrl: flags['tso-url'],
      }
      fs.writeFileSync(path.join(outDir, 'signer-policy.json'), `${JSON.stringify(policy, null, 2)}\n`)

      // Env-file form for docker-compose deployments: mounts assume the two
      // policy TOML files sit next to the compose file at /etc/dogeos/.
      const envLines = [
        '# Post-genesis production policy for a partner-operated attestation-signer.',
        '# Apply next to your existing ATTESTATION_SIGNER_WIF / KMS settings and restart.',
        '# Overrides the pre-genesis staging_scaffold mode: the signer now enforces',
        '# the fail-closed production policy against this bridge identity.',
        'ATTESTATION_SIGNER_POLICY_MODE=production_enforce',
        `ATTESTATION_SIGNER_NETWORK=${config.network}`,
        `ATTESTATION_SIGNER_PROTOCOL_INSTANCE_ID=${protocolInstanceId}`,
        `ATTESTATION_SIGNER_BRIDGE_NAMESPACE_ID=${bridgeNamespaceId}`,
        `ATTESTATION_SIGNER_ACTIVE_BRIDGE_KEY_HASH=${activeBridgeKeyHash}`,
        `ATTESTATION_SIGNER_SUPPORTED_SIGNING_POLICY_VERSIONS=${flags['supported-signing-policy-versions']}`,
        'ATTESTATION_SIGNER_VERIFIER_REGISTRY_TOML=/etc/dogeos/verifier-registry.toml',
        'ATTESTATION_SIGNER_SOURCE_SET_TOML=/etc/dogeos/source-set.toml',
        `ATTESTATION_SIGNER_TEE_ALLOWED_SIGNER_IDS=${flags['tee-allowed-signer-ids']}`,
        `ATTESTATION_SIGNER_ENVELOPE_ALLOWED_PROOF_TRIPLES=${flags['allowed-proof-triples']}`,
        `ATTESTATION_SIGNER_TSO_URL=${flags['tso-url']}`,
        'ATTESTATION_SIGNER_TSO_CALLBACK_PHASE=attestation',
        'ATTESTATION_SIGNER_PROOF_ARTIFACT_FETCH_MODE=http',
      ]
      fs.writeFileSync(path.join(outDir, 'signer-policy.env'), `${envLines.join('\n')}\n`)

      // Helm overlay form for operators running the attestation-signer chart.
      const overlay = [
        '# Merge into your attestation-signer values and upgrade the release.',
        'attestationSigner:',
        `  network: ${config.network}`,
        '  profile: production-kms',
        '  productionPolicy:',
        `    protocolInstanceId: "${protocolInstanceId}"`,
        `    bridgeNamespaceId: "${bridgeNamespaceId}"`,
        `    activeBridgeKeyHash: "${activeBridgeKeyHash}"`,
        `    supportedSigningPolicyVersions: "${flags['supported-signing-policy-versions']}"`,
        `    teeAllowedSignerIds: "${flags['tee-allowed-signer-ids']}"`,
        '    verifierRegistryToml: /etc/dogeos/verifier-registry.toml',
        '    sourceSetToml: /etc/dogeos/source-set.toml',
        '  envelopePolicy:',
        `    allowedProofTriples: "${flags['allowed-proof-triples']}"`,
        '  proofArtifact:',
        '    fetchMode: http',
        '  tso:',
        `    url: ${flags['tso-url']}`,
        '    callbackPhase: attestation',
        'configMaps:',
        '  config:',
        '    enabled: true',
        '    data: {} # mount verifier-registry.toml and source-set.toml from this bundle',
      ]
      fs.writeFileSync(path.join(outDir, 'values-overlay.yaml'), `${overlay.join('\n')}\n`)

      const result = {
        activeBridgeKeyHash,
        bridgeNamespaceId,
        bundleDir: outDir,
        files: ['signer-policy.json', 'signer-policy.env', 'values-overlay.yaml', 'verifier-registry.toml', 'source-set.toml'],
        protocolInstanceId,
        signerCount: external.length,
      }
      if (flags.json) json.success(result)
      else this.log(chalk.green(`Policy bundle written to ${outDir} — send the whole directory to every signer operator (${external.map(signer => signer.id).join(', ')}).`))
    } catch (error) {
      json.error('E804_SIGNER_POLICY_EXPORT_FAILED', error instanceof Error ? error.message : String(error), 'CONFIGURATION', true)
    }
  }

  private readNamespaceIdFromGenerateBridgeInfo(): string {
    const file = path.resolve('.data/GenerateBridgeInfo.toml')
    if (!fs.existsSync(file)) {
      throw new Error('bridge namespace id unavailable: pass --bridge-namespace-id or run scrollsdk setup bridge-init --step 3-bridge-info (expected .data/GenerateBridgeInfo.toml)')
    }

    const data = toml.parse(fs.readFileSync(file, 'utf8')) as any
    const value = data.namespace_id || data.namespaceId
    if (typeof value !== 'string' || value === '') {
      throw new Error(`.data/GenerateBridgeInfo.toml has no namespace_id; pass --bridge-namespace-id explicitly`)
    }

    return value
  }
}

export default ExportSignerPolicyCommand
