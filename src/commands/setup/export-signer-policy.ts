import { Command, Flags } from '@oclif/core'
import chalk from 'chalk'
import fs from 'node:fs'
import path from 'node:path'

import { normalizeExternalHttpBaseUrl } from '../../utils/attestation-signer-descriptor.js'
import { loadDogeConfigWithSelection } from '../../utils/doge-config.js'
import { JsonOutputContext } from '../../utils/json-output.js'
import {
  DEFAULT_PROOF_COORDINATOR_CONFIG,
  DEFAULT_PROOF_PROGRAM_MANIFESTS,
  deriveAllowedProofTriples,
  normalizeSignerProofArtifactBaseUrl,
  readStagedSignerProofArtifactBaseUrl,
} from '../../utils/proof-configurator.js'
import {
  DEFAULT_ENVELOPE_MAX_PROOF_ARTIFACTS,
  renderPartnerCommands,
  renderSignerPolicyEnv,
  signerRuntimePolicyProfile,
} from '../../utils/signer-policy-bundle.js'
import {
  deriveBridgeNamespaceId,
  deriveProtocolInstanceId,
  deriveTeeAllowedSignerIds,
  deriveTsoUrl,
  protocolIdSidecarPath,
} from '../../utils/signer-policy-derivation.js'
import { WITHDRAWAL_NATIVE_CONFIG_RELPATH } from '../../utils/withdrawal-config.js'

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
 * signer operator needs to switch their attestation-signer into the bridge's
 * selected policy profile. Mock proving mirrors e2e_harness's audited
 * staging-scaffold posture; production proving remains fail-closed. The bundle
 * is chain-level (identical for every signer of this bridge) — the only
 * per-operator value is the signer's own key, which the operator already holds.
 */
export class ExportSignerPolicyCommand extends Command {
  static description = 'Assemble the post-genesis policy bundle and exact address-bearing commands for partner-operated attestation signers. The proving mode persisted by setup proof-config selects the e2e_harness-compatible mock signer posture or the fail-closed production posture; partners run the same descriptor, compose, policy-apply, TSO callback, and proof-fetch flow.'

  static examples = [
    '$ scrollsdk setup export-signer-policy',
    '$ scrollsdk setup export-signer-policy --tso-url https://tso.dogeos.example --allowed-proof-triples "scroll_batch:scroll-production-v1:<vk-hash>"',
  ]

  static flags = {
    'allowed-proof-triples': Flags.string({ description: 'Envelope proof-triple allowlist (same format setup proof-config projects); default: derived from the staged ProofCoordinator.toml verifier block or the proof-artifacts manifests, empty when the proof topology is not staged yet (pass "" to force empty)' }),
    'bridge-namespace-id': Flags.string({ description: '20-byte bridge namespace id; default is read from .data/GenerateBridgeInfo.toml (namespace_id) written by bridge-init step 3' }),
    config: Flags.string({ char: 'c', description: 'Path to doge-config.toml' }),
    json: Flags.boolean({ default: false, description: 'Output structured JSON' }),
    out: Flags.string({ default: 'signer-policy-bundle', description: 'Bundle output directory' }),
    'protocol-context': Flags.string({ default: '.data/protocol_context.json', description: 'protocol_context.json produced by setup bridge-init step 5' }),
    'protocol-instance-id': Flags.string({ description: '32-byte protocol instance id (canonical protocol opening hash); default: read from the protocol_id sidecar next to --protocol-context written by bridge-init step 5' }),
    'signer-proof-artifact-base-url': Flags.string({ description: `Stable public GET base signers use to fetch accepted proof objects; default: the value setup proof-config staged into ${WITHDRAWAL_NATIVE_CONFIG_RELPATH}` }),
    'source-set': Flags.string({ default: 'configs/source-set.toml', description: 'source-set.toml to include in the bundle' }),
    'supported-signing-policy-versions': Flags.string({ default: '1', description: 'CSV of supported signing policy versions' }),
    'tee-allowed-signer-ids': Flags.string({ description: 'CSV of allowed TEE signer ids (compressed secp256k1 pubkeys); default: the tee_pubkey recorded in .data/setup_defaults.toml by cubesigner-init (pass "" to force empty)' }),
    'tso-url': Flags.string({ description: 'TSO base URL reachable FROM the signer operator network (used for signature callbacks); default: https://<[ingress].TSO_HOST> from config.toml' }),
    'verifier-registry': Flags.string({ default: 'configs/verifier-registry.toml', description: 'verifier-registry.toml to include in the bundle' }),
  }

  async run(): Promise<void> {
    const { flags } = await this.parse(ExportSignerPolicyCommand)
    const json = new JsonOutputContext('setup export-signer-policy', flags.json)
    try {
      const loaded = await loadDogeConfigWithSelection(flags.config, 'scrollsdk setup doge-config')
      const { config } = loaded
      const provingMode = config.proofSystem?.provingMode || 'production'
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

      const {
        allowedProofTriples,
        bridgeNamespaceId,
        derivedSources,
        protocolInstanceId,
        signerProofArtifactBaseUrl,
        teeAllowedSignerIds,
        tsoUrl,
      } = this.resolveDerivableInputs(flags, contextPath, json)

      const verifierRegistryPath = path.resolve(flags['verifier-registry'])
      const sourceSetPath = path.resolve(flags['source-set'])
      for (const [file, name] of [[verifierRegistryPath, '--verifier-registry'], [sourceSetPath, '--source-set']] as const) {
        if (!fs.existsSync(file)) throw new Error(`${name} file not found: ${file}`)
      }

      const outDir = path.resolve(flags.out)
      fs.mkdirSync(outDir, { recursive: true })
      // Removed in the partner-compose-only deployment model. A bundle may be
      // regenerated into an existing directory, so actively delete the stale
      // Helm overlay instead of merely stopping its creation.
      fs.rmSync(path.join(outDir, 'values-overlay.yaml'), { force: true })
      fs.copyFileSync(verifierRegistryPath, path.join(outDir, 'verifier-registry.toml'))
      fs.copyFileSync(sourceSetPath, path.join(outDir, 'source-set.toml'))

      const bundleInput = {
        activeBridgeKeyHash,
        allowedProofTriples,
        bridgeNamespaceId,
        network: config.network,
        protocolInstanceId,
        provingMode,
        signerProofArtifactBaseUrl,
        signers: external.map(signer => ({ endpoint: signer.endpoint, id: signer.id, publicKey: signer.publicKey })),
        supportedSigningPolicyVersions: flags['supported-signing-policy-versions'],
        teeAllowedSignerIds,
        tsoUrl,
      }
      const runtimeProfile = signerRuntimePolicyProfile(provingMode)
      const policy = {
        activeBridgeKeyHash,
        allowedProofTriples,
        bridgeNamespaceId,
        envelopeMaxProofArtifacts: DEFAULT_ENVELOPE_MAX_PROOF_ARTIFACTS,
        network: config.network,
        protocolInstanceId,
        provingMode,
        signerPolicyMode: runtimeProfile.policyMode,
        signerProofArtifactBaseUrl,
        signers: bundleInput.signers,
        supportedSigningPolicyVersions: flags['supported-signing-policy-versions'],
        teeAllowedSignerIds,
        tsoUrl,
      }
      fs.writeFileSync(path.join(outDir, 'signer-policy.json'), `${JSON.stringify(policy, null, 2)}\n`)
      fs.writeFileSync(path.join(outDir, 'signer-policy.env'), renderSignerPolicyEnv(bundleInput))
      fs.writeFileSync(path.join(outDir, 'PARTNER-COMMANDS.md'), renderPartnerCommands(bundleInput))

      const result = {
        activeBridgeKeyHash,
        allowedProofTriples,
        bridgeNamespaceId,
        bundleDir: outDir,
        derivedSources,
        envelopeMaxProofArtifacts: DEFAULT_ENVELOPE_MAX_PROOF_ARTIFACTS,
        files: ['signer-policy.json', 'signer-policy.env', 'verifier-registry.toml', 'source-set.toml', 'PARTNER-COMMANDS.md'],
        protocolInstanceId,
        provingMode,
        signerCount: external.length,
        signerPolicyMode: runtimeProfile.policyMode,
        signerProofArtifactBaseUrl,
        teeAllowedSignerIds,
        tsoUrl,
      }
      if (flags.json) json.success(result)
      else this.log(chalk.green(`${provingMode} policy bundle written to ${outDir} — send the whole directory to every signer operator (${external.map(signer => signer.id).join(', ')}); PARTNER-COMMANDS.md contains their exact addresses and commands.`))
    } catch (error) {
      json.error('E804_SIGNER_POLICY_EXPORT_FAILED', error instanceof Error ? error.message : String(error), 'CONFIGURATION', true)
    }
  }

  /**
   * Resolve the bundle inputs that are derivable from deployment artifacts;
   * flags are overrides. Each derived value is reported with its source so
   * the operator can audit what went into the bundle.
   */
  private resolveDerivableInputs(
    flags: {
      'allowed-proof-triples'?: string
      'bridge-namespace-id'?: string
      'protocol-instance-id'?: string
      'signer-proof-artifact-base-url'?: string
      'tee-allowed-signer-ids'?: string
      'tso-url'?: string
    },
    contextPath: string,
    json: JsonOutputContext
  ): {
    allowedProofTriples: string
    bridgeNamespaceId: string
    derivedSources: Record<string, string>
    protocolInstanceId: string
    signerProofArtifactBaseUrl: string
    teeAllowedSignerIds: string
    tsoUrl: string
  } {
    const derivedSources: Record<string, string> = {}
    const derive = (flagName: string, derived: { source: string; value: string } | undefined): string | undefined => {
      if (derived === undefined) return undefined
      derivedSources[flagName] = derived.source
      json.info(`--${flagName} derived from ${derived.source}`)
      return derived.value
    }

    const bridgeNamespaceIdInput = flags['bridge-namespace-id']
      ?? derive('bridge-namespace-id', deriveBridgeNamespaceId())
    if (bridgeNamespaceIdInput === undefined) {
      throw new Error('bridge namespace id unavailable: run scrollsdk setup bridge-init --step 3-bridge-info (expected namespace_id in .data/GenerateBridgeInfo.toml) or pass --bridge-namespace-id')
    }

    const protocolInstanceIdInput = flags['protocol-instance-id']
      ?? derive('protocol-instance-id', deriveProtocolInstanceId(contextPath))
    if (protocolInstanceIdInput === undefined) {
      throw new Error(`${protocolIdSidecarPath(contextPath)} not found; re-run scrollsdk setup bridge-init --step 5-protocol-context with a dogeos-core image that emits the protocol_id sidecar, or pass --protocol-instance-id`)
    }

    const tsoUrl = flags['tso-url'] ?? derive('tso-url', deriveTsoUrl())
    if (tsoUrl === undefined) {
      throw new Error('config.toml has no [ingress].TSO_HOST to derive the TSO base URL from; pass --tso-url')
    }

    const stagedBaseUrl = fs.existsSync(WITHDRAWAL_NATIVE_CONFIG_RELPATH)
      ? readStagedSignerProofArtifactBaseUrl(fs.readFileSync(WITHDRAWAL_NATIVE_CONFIG_RELPATH, 'utf8'))
      : undefined
    const signerProofArtifactBaseUrlInput = flags['signer-proof-artifact-base-url']
      ?? derive('signer-proof-artifact-base-url', stagedBaseUrl === undefined
        ? undefined
        : { source: `${WITHDRAWAL_NATIVE_CONFIG_RELPATH} [proof_system].signer_proof_artifact_base_url`, value: stagedBaseUrl })
    if (signerProofArtifactBaseUrlInput === undefined) {
      throw new Error(`no staged signer proof-artifact base URL found in ${WITHDRAWAL_NATIVE_CONFIG_RELPATH}; run scrollsdk setup proof-config first or pass --signer-proof-artifact-base-url`)
    }

    return {
      allowedProofTriples: flags['allowed-proof-triples']
        ?? derive('allowed-proof-triples', deriveAllowedProofTriples(DEFAULT_PROOF_COORDINATOR_CONFIG, DEFAULT_PROOF_PROGRAM_MANIFESTS))
        ?? '',
      bridgeNamespaceId: require20ByteHex(bridgeNamespaceIdInput, 'bridge namespace id'),
      derivedSources,
      protocolInstanceId: require32ByteHex(protocolInstanceIdInput, '--protocol-instance-id'),
      signerProofArtifactBaseUrl: normalizeSignerProofArtifactBaseUrl(signerProofArtifactBaseUrlInput),
      teeAllowedSignerIds: flags['tee-allowed-signer-ids']
        ?? derive('tee-allowed-signer-ids', deriveTeeAllowedSignerIds())
        ?? '',
      tsoUrl: normalizeExternalHttpBaseUrl(tsoUrl, '--tso-url', { remoteNetwork: 'signer operator network' }),
    }
  }
}

export default ExportSignerPolicyCommand
