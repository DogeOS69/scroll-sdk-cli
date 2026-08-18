import { Command, Flags } from '@oclif/core'
import chalk from 'chalk'
import fs from 'node:fs'
import path from 'node:path'

import type { ProofSystemMode } from '../../utils/proof-system-mode.js'

import { normalizeExternalHttpBaseUrl } from '../../utils/attestation-signer-descriptor.js'
import { loadDogeConfigWithSelection } from '../../utils/doge-config.js'
import { JsonOutputContext } from '../../utils/json-output.js'
import { assertPreTsukiDirectSignPosture } from '../../utils/pre-tsuki-direct-sign.js'
import {
  DEFAULT_PROOF_COORDINATOR_CONFIG,
  DEFAULT_PROOF_PROGRAM_MANIFESTS,
  deriveAllowedProofTriples,
  normalizeSignerProofArtifactBaseUrl,
  readStagedSignerProofArtifactBaseUrl,
} from '../../utils/proof-configurator.js'
import { resolveProofIntent } from '../../utils/proof-intent.js'
import { normalizeCompressedSecp256k1PublicKeyCsv } from '../../utils/secp256k1-public-key.js'
import {
  renderDisabledSourceSetToml,
  renderDisabledVerifierRegistryToml,
  renderMockSourceSetToml,
  renderPartnerCommands,
  renderSignerPolicyEnv,
  renderVerifierRegistryToml,
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
  static description = 'Assemble the post-genesis policy bundle for the proof-system mode reconciled by setup prep-charts: disabled selects direct-sign/dev_permissive with proof fetch off, mock selects staging_scaffold with basic proof checks, and production selects fail-closed production_enforce.'

  static examples = [
    '$ scrollsdk setup export-signer-policy',
    '$ scrollsdk setup export-signer-policy --tso-url https://tso.dogeos.example --allowed-proof-triples "scroll_batch:scroll-production-v1:<vk-hash>"',
  ]

  static flags = {
    'allowed-proof-triples': Flags.string({ description: 'Envelope proof-triple allowlist; default: derived from the ProofCoordinator.toml or proof-artifacts manifests staged by prep-charts; missing/empty fails closed' }),
    'bridge-namespace-id': Flags.string({ description: '20-byte bridge namespace id; default is read from .data/GenerateBridgeInfo.toml (namespace_id) written by bridge-init step 3' }),
    config: Flags.string({ char: 'c', description: 'Path to doge-config.toml' }),
    json: Flags.boolean({ default: false, description: 'Output structured JSON' }),
    out: Flags.string({ default: 'signer-policy-bundle', description: 'Bundle output directory' }),
    'protocol-context': Flags.string({ default: '.data/protocol_context.json', description: 'protocol_context.json produced by setup bridge-init step 5' }),
    'protocol-instance-id': Flags.string({ description: '32-byte protocol instance id (canonical protocol opening hash); default: read from the protocol_id sidecar next to --protocol-context written by bridge-init step 5' }),
    'signer-proof-artifact-base-url': Flags.string({ description: `Stable public GET base signers use to fetch accepted proof objects; default: the value prep-charts staged into ${WITHDRAWAL_NATIVE_CONFIG_RELPATH}` }),
    'source-set': Flags.string({ description: 'source-set.toml override. Mock defaults to an e2e_harness empty scaffold; production defaults to configs/source-set.toml' }),
    spec: Flags.string({ description: 'Optional DeploymentSpec proof-intent source; auto-detects deployment-spec.yaml/yml when omitted' }),
    'supported-signing-policy-versions': Flags.string({ default: '1', description: 'CSV of supported signing policy versions' }),
    'tee-allowed-signer-ids': Flags.string({ description: 'CSV of allowed TEE signer ids; compressed or uncompressed SEC1 keys are normalized to dogeos-core\'s compressed form. Production defaults to .data/setup_defaults.toml tee_pubkey; mock defaults to empty, matching e2e_harness' }),
    'tso-url': Flags.string({ description: 'TSO base URL reachable FROM the signer operator network (used for signature callbacks); default: https://<[ingress].TSO_HOST> from config.toml' }),
    'verifier-registry': Flags.string({ description: 'verifier-registry.toml override; default is generated from the proof triples staged by setup prep-charts' }),
  }

  async run(): Promise<void> {
    const { flags } = await this.parse(ExportSignerPolicyCommand)
    const json = new JsonOutputContext('setup export-signer-policy', flags.json)
    try {
      const loaded = await loadDogeConfigWithSelection(flags.config, 'scrollsdk setup doge-config')
      const { config } = loaded
      const resolvedIntent = resolveProofIntent({
        deploymentDir: process.cwd(),
        dogeConfig: config,
        dogeConfigPath: loaded.configPath,
        specPath: flags.spec,
      })
      const {mode} = resolvedIntent.intent
      assertPreTsukiDirectSignPosture({
        mode,
        network: config.network,
        preTsukiDirectSign: resolvedIntent.intent.preTsukiDirectSign,
        source: resolvedIntent.source.path,
      })
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
      } = this.resolveDerivableInputs(flags, contextPath, mode, json)

      const outDir = path.resolve(flags.out)
      fs.mkdirSync(outDir, { recursive: true })
      // Every signer receives the exact reviewed context bytes. The partner
      // compose mounts its policy directory read-only at /etc/dogeos.
      fs.copyFileSync(contextPath, path.join(outDir, 'protocol_context.json'))
      // Removed in the partner-compose-only deployment model. A bundle may be
      // regenerated into an existing directory, so actively delete the stale
      // Helm overlay instead of merely stopping its creation.
      fs.rmSync(path.join(outDir, 'values-overlay.yaml'), { force: true })
      const verifierRegistryOutput = path.join(outDir, 'verifier-registry.toml')
      if (mode === 'disabled') {
        fs.writeFileSync(verifierRegistryOutput, renderDisabledVerifierRegistryToml())
        derivedSources['verifier-registry'] = 'proof-system disabled posture'
      } else if (flags['verifier-registry']) {
        const verifierRegistryPath = path.resolve(flags['verifier-registry'])
        if (!fs.existsSync(verifierRegistryPath)) throw new Error(`--verifier-registry file not found: ${verifierRegistryPath}`)
        fs.copyFileSync(verifierRegistryPath, verifierRegistryOutput)
      } else {
        fs.writeFileSync(verifierRegistryOutput, renderVerifierRegistryToml(allowedProofTriples))
        derivedSources['verifier-registry'] = 'proof triples staged by setup prep-charts'
        json.info('--verifier-registry generated from proof triples staged by setup prep-charts')
      }

      const sourceSetOutput = path.join(outDir, 'source-set.toml')
      const conventionalProductionSourceSet = path.resolve('configs/source-set.toml')
      const sourceSetPath = flags['source-set']
        ? path.resolve(flags['source-set'])
        : resolvedIntent.intent.signerPolicy?.sourceSet
          ? path.resolve(resolvedIntent.intent.signerPolicy.sourceSet)
          : (mode === 'production' ? conventionalProductionSourceSet : undefined)
      if (mode === 'disabled') {
        fs.writeFileSync(sourceSetOutput, renderDisabledSourceSetToml())
        derivedSources['source-set'] = 'proof-system disabled posture'
      } else if (sourceSetPath) {
        if (!fs.existsSync(sourceSetPath)) {
          throw new Error(flags['source-set']
            ? `--source-set file not found: ${sourceSetPath}`
            : `production signer policy requires source-set.toml at the standard path ${conventionalProductionSourceSet}; create it with real partner-reachable RPC sources or pass --source-set`)
        }

        fs.copyFileSync(sourceSetPath, sourceSetOutput)
      } else {
        fs.writeFileSync(sourceSetOutput, renderMockSourceSetToml())
        derivedSources['source-set'] = 'mock e2e_harness empty scaffold'
        json.info('--source-set generated as mock e2e_harness empty scaffold')
      }

      const bundleInput = {
        activeBridgeKeyHash,
        allowedProofTriples,
        bridgeNamespaceId,
        mode,
        network: config.network,
        preTsukiDirectSign: resolvedIntent.intent.preTsukiDirectSign,
        protocolInstanceId,
        signerProofArtifactBaseUrl,
        signers: external.map(signer => ({ endpoint: signer.endpoint, id: signer.id, publicKey: signer.publicKey })),
        supportedSigningPolicyVersions: flags['supported-signing-policy-versions'],
        teeAllowedSignerIds,
        tsoUrl,
      }
      const runtimeProfile = signerRuntimePolicyProfile(mode)
      const policy = {
        activeBridgeKeyHash,
        allowedProofTriples,
        bridgeNamespaceId,
        envelopeMaxProofArtifacts: runtimeProfile.envelopeMaxProofArtifacts,
        mode,
        network: config.network,
        preTsukiDirectSign: resolvedIntent.intent.preTsukiDirectSign,
        protocolInstanceId,
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
        envelopeMaxProofArtifacts: runtimeProfile.envelopeMaxProofArtifacts,
        files: ['protocol_context.json', 'signer-policy.json', 'signer-policy.env', 'verifier-registry.toml', 'source-set.toml', 'PARTNER-COMMANDS.md'],
        mode,
        protocolInstanceId,
        signerCount: external.length,
        signerPolicyMode: runtimeProfile.policyMode,
        signerProofArtifactBaseUrl,
        teeAllowedSignerIds,
        tsoUrl,
      }
      if (flags.json) json.success(result)
      else this.log(chalk.green(`${mode} policy bundle written to ${outDir} — send the whole directory to every signer operator (${external.map(signer => signer.id).join(', ')}); PARTNER-COMMANDS.md contains their exact addresses and commands.`))
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
    mode: ProofSystemMode,
    json: JsonOutputContext
  ): {
    allowedProofTriples: string
    bridgeNamespaceId: string
    derivedSources: Record<string, string>
    protocolInstanceId: string
    signerProofArtifactBaseUrl?: string
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
    if (mode !== 'disabled' && signerProofArtifactBaseUrlInput === undefined) {
      throw new Error(`no staged signer proof-artifact base URL found in ${WITHDRAWAL_NATIVE_CONFIG_RELPATH}; run scrollsdk setup prep-charts first or pass --signer-proof-artifact-base-url`)
    }

    // e2e_harness's staging-scaffold mock signer carries proof artifacts but
    // no TEE receipt, so it intentionally leaves both TEE allowlists empty.
    // Production requires the bridge TEE signer id; accept legacy CubeSigner
    // 04+X+Y values at the boundary and canonicalize them to dogeos-core's
    // 02/03+X representation.
    const teeFlag = flags['tee-allowed-signer-ids']
    const teeAllowedSignerIds = teeFlag === undefined
      ? (mode === 'production'
          ? derive('tee-allowed-signer-ids', deriveTeeAllowedSignerIds()) ?? ''
          : '')
      : normalizeCompressedSecp256k1PublicKeyCsv(teeFlag, '--tee-allowed-signer-ids')
    if (mode === 'production' && teeAllowedSignerIds === '') {
      throw new Error('production signer policy requires a TEE signer id; run scrollsdk setup cubesigner-init first or pass --tee-allowed-signer-ids')
    }

    const allowedProofTriples = mode === 'disabled' ? '' : flags['allowed-proof-triples']
      ?? derive('allowed-proof-triples', deriveAllowedProofTriples(DEFAULT_PROOF_COORDINATOR_CONFIG, DEFAULT_PROOF_PROGRAM_MANIFESTS))
      ?? ''
    if (mode !== 'disabled' && allowedProofTriples === '') {
      throw new Error('no staged proof triples found; run scrollsdk setup prep-charts first or pass --allowed-proof-triples')
    }

    return {
      allowedProofTriples,
      bridgeNamespaceId: require20ByteHex(bridgeNamespaceIdInput, 'bridge namespace id'),
      derivedSources,
      protocolInstanceId: require32ByteHex(protocolInstanceIdInput, '--protocol-instance-id'),
      signerProofArtifactBaseUrl: signerProofArtifactBaseUrlInput === undefined
        ? undefined
        : normalizeSignerProofArtifactBaseUrl(signerProofArtifactBaseUrlInput),
      teeAllowedSignerIds,
      tsoUrl: normalizeExternalHttpBaseUrl(tsoUrl, '--tso-url', { remoteNetwork: 'signer operator network' }),
    }
  }
}

export default ExportSignerPolicyCommand
