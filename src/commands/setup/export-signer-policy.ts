import {Command, Flags} from '@oclif/core'
import chalk from 'chalk'
import {createHash} from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import type {ResolvedProofIntent} from '../../utils/proof-intent.js'
import type {SignerAdvanceL2VerifierMaterial} from '../../utils/signer-policy-bundle.js'

import {normalizeExternalHttpBaseUrl} from '../../utils/attestation-signer-descriptor.js'
import {loadDogeConfigWithSelection} from '../../utils/doge-config.js'
import {JsonOutputContext} from '../../utils/json-output.js'
import {assertPreTsukiDirectSignPosture} from '../../utils/pre-tsuki-direct-sign.js'
import {resolveProofIntent} from '../../utils/proof-intent.js'
import {verifyProductionReleaseBinding} from '../../utils/proof-release.js'
import {
  normalizeSignerProofArtifactBaseUrl,
  readStagedSignerProofArtifactBaseUrl,
} from '../../utils/proof-signer-policy-input.js'
import {
  ADVANCE_L2_AGG_VERIFYING_KEY_BUNDLE_FILE,
  renderPartnerCommands,
  renderSignerPolicyEnv,
  signerRuntimePolicyProfile,
} from '../../utils/signer-policy-bundle.js'
import {deriveTsoUrl} from '../../utils/signer-policy-derivation.js'
import {WITHDRAWAL_NATIVE_CONFIG_RELPATH} from '../../utils/withdrawal-config.js'

const BUNDLE_SCHEMA = 'dogeos/attestation-signer-policy-bundle/v2'
const MANIFEST_SCHEMA = 'dogeos/attestation-signer-policy-manifest/v1'

function sha256(contents: Buffer | string): string {
  return `sha256:${createHash('sha256').update(contents).digest('hex')}`
}

function require20ByteHex(value: string, name: string): string {
  const normalized = value.toLowerCase().startsWith('0x') ? value.toLowerCase() : `0x${value.toLowerCase()}`
  if (!/^0x[\da-f]{40}$/.test(normalized)) throw new Error(`${name} must be 20-byte hex (0x + 40 hex chars)`)
  return normalized
}

function require64ByteHex(value: string | undefined, name: string): string {
  const normalized = value?.toLowerCase()
  if (!normalized || !/^0x[\da-f]{128}$/.test(normalized)) {
    throw new Error(`${name} must be canonical 64-byte hex (0x + 128 hex chars)`)
  }

  return normalized
}

function assertRegularNonSymlinkFile(file: string, name: string): void {
  if (!fs.existsSync(file)) throw new Error(`${name} not found: ${file}`)
  const stat = fs.lstatSync(file)
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`${name} must be a regular non-symlink file: ${file}`)
}

function resolveProductionVerifier(
  resolved: ResolvedProofIntent,
  outDir: string,
): SignerAdvanceL2VerifierMaterial {
  const prepared = verifyProductionReleaseBinding(resolved.proofTopology, process.cwd())
  if (!prepared) {
    throw new Error(
      'production proof topology has no prepared ProofSoftwareReleaseV1/ProofBridgeMaterialV1 inputs',
    )
  }

  const resourcesRoot = prepared.softwareRoot
  if (!fs.existsSync(resourcesRoot)) throw new Error(`production resourcesRoot not found: ${resourcesRoot}`)
  const resourcesRootStat = fs.lstatSync(resourcesRoot)
  if (resourcesRootStat.isSymbolicLink() || !resourcesRootStat.isDirectory()) {
    throw new Error(`production resourcesRoot must be a non-symlink directory: ${resourcesRoot}`)
  }

  const relativeKey = prepared.release.materials.aggregate_verification_key.path
  if (!relativeKey || path.isAbsolute(relativeKey)) {
    throw new Error('ProofSoftwareReleaseV1 aggregate verification key must be relative to its root')
  }

  const source = path.resolve(resourcesRoot, relativeKey)
  const inside = path.relative(resourcesRoot, source)
  if (inside === '..' || inside.startsWith(`..${path.sep}`) || path.isAbsolute(inside)) {
    throw new Error('proofTopology.production.realScroll.aggVerifyingKeyPath escapes resourcesRoot')
  }

  assertRegularNonSymlinkFile(source, 'production aggregate verifying key')
  const canonicalRoot = fs.realpathSync(resourcesRoot)
  const canonicalSource = fs.realpathSync(source)
  const canonicalInside = path.relative(canonicalRoot, canonicalSource)
  if (canonicalInside === '..' || canonicalInside.startsWith(`..${path.sep}`) || path.isAbsolute(canonicalInside)) {
    throw new Error('production aggregate verifying key resolves outside resourcesRoot through a symlink')
  }

  const contents = fs.readFileSync(source)
  if (contents.length === 0) throw new Error(`production aggregate verifying key is empty: ${source}`)
  fs.writeFileSync(path.join(outDir, ADVANCE_L2_AGG_VERIFYING_KEY_BUNDLE_FILE), contents)

  return {
    aggVerifyingKeyFile: ADVANCE_L2_AGG_VERIFYING_KEY_BUNDLE_FILE,
    aggVerifyingKeySha256: sha256(contents),
    batchProgramCommitmentHex: require64ByteHex(
      prepared.release.identities.batch.program_commitment_le_raw,
      'ProofSoftwareReleaseV1 identities.batch.program_commitment_le_raw',
    ),
    l2RangeAggregationProgramCommitmentHex: require64ByteHex(
      prepared.release.identities.l2_range.app_commit_raw,
      'ProofSoftwareReleaseV1 identities.l2_range.app_commit_raw',
    ),
  }
}

function writeManifest(outDir: string, payloadFiles: string[]): void {
  const files = [...payloadFiles].sort().map(file => {
    const contents = fs.readFileSync(path.join(outDir, file))
    return {file, sha256: sha256(contents), sizeBytes: contents.length}
  })
  fs.writeFileSync(path.join(outDir, 'signer-policy-manifest.json'), `${JSON.stringify({files, schema: MANIFEST_SCHEMA}, null, 2)}\n`)
}

export class ExportSignerPolicyCommand extends Command {
  static description = 'Export the dogeos-core attestation_evidence_v2 policy selected by the current proof topology. The bundle contains bridge-owned protocol/verifier inputs; each signer operator keeps its RPC source sets, rotation allowlists, keys, and release pins.'

  static examples = [
    '$ scrollsdk setup export-signer-policy',
    '$ scrollsdk setup export-signer-policy --tso-url https://tso.dogeos.example',
  ]

  static flags = {
    config: Flags.string({char: 'c', description: 'Path to doge-config.toml'}),
    json: Flags.boolean({default: false, description: 'Output structured JSON'}),
    out: Flags.string({default: 'signer-policy-bundle', description: 'Bundle output directory'}),
    'protocol-context': Flags.string({default: '.data/protocol_context.json', description: 'Canonical protocol_context.json produced by setup bridge-init'}),
    'signer-proof-artifact-base-url': Flags.string({description: `Public GET base used by signers; default: compiler output in ${WITHDRAWAL_NATIVE_CONFIG_RELPATH}`}),
    spec: Flags.string({description: 'Optional DeploymentSpec proof source; conflicts with doge-config [proof_topology]'}),
    'tso-url': Flags.string({description: 'TSO base URL reachable from signer networks; default: config.toml [ingress].TSO_HOST'}),
  }

  async run(): Promise<void> {
    const {flags} = await this.parse(ExportSignerPolicyCommand)
    const json = new JsonOutputContext('setup export-signer-policy', flags.json)
    try {
      const loaded = await loadDogeConfigWithSelection(flags.config, 'scrollsdk setup doge-config')
      const {config} = loaded
      const resolved = resolveProofIntent({
        deploymentDir: process.cwd(),
        dogeConfig: config,
        dogeConfigPath: loaded.configPath,
        specPath: flags.spec,
      })!
      const {mode} = resolved.intent
      assertPreTsukiDirectSignPosture({
        mode,
        network: config.network,
        preTsukiDirectSign: resolved.intent.preTsukiDirectSign,
        source: resolved.source.path,
      })

      const signers = config.attestationSigner?.external
      if (!signers || signers.length === 0 || config.attestationSigner?.mode !== 'external') {
        throw new Error('doge-config has no external attestation signers; run scrollsdk setup attestation-signer first')
      }

      const contextPath = path.resolve(flags['protocol-context'])
      assertRegularNonSymlinkFile(contextPath, 'canonical protocol context')
      const protocolContextBytes = fs.readFileSync(contextPath)
      const protocolContext = JSON.parse(protocolContextBytes.toString('utf8')) as unknown
      if (!protocolContext || typeof protocolContext !== 'object' || Array.isArray(protocolContext)) {
        throw new Error('protocol_context.json must contain a JSON object')
      }

      const {genesis} = protocolContext as Record<string, unknown>
      if (!genesis || typeof genesis !== 'object' || Array.isArray(genesis)) {
        throw new Error('protocol_context.json genesis must be a JSON object')
      }

      const activeBridgeKeyHash = require20ByteHex(
        String((genesis as Record<string, unknown>).genesis_bridge_key_hash || ''),
        'protocol_context.json genesis.genesis_bridge_key_hash',
      )

      const derivedSources: Record<string, string> = {}
      const derivedTso = deriveTsoUrl()
      const tsoInput = flags['tso-url'] || derivedTso?.value
      if (!tsoInput) throw new Error('config.toml has no [ingress].TSO_HOST; pass --tso-url')
      if (!flags['tso-url'] && derivedTso) derivedSources.tsoUrl = derivedTso.source
      const tsoUrl = normalizeExternalHttpBaseUrl(tsoInput, '--tso-url', {remoteNetwork: 'signer operator network'})

      const stagedArtifactUrl = fs.existsSync(WITHDRAWAL_NATIVE_CONFIG_RELPATH)
        ? readStagedSignerProofArtifactBaseUrl(fs.readFileSync(WITHDRAWAL_NATIVE_CONFIG_RELPATH, 'utf8'))
        : undefined
      const artifactInput = flags['signer-proof-artifact-base-url'] || stagedArtifactUrl
      if (mode !== 'disabled' && !artifactInput) {
        throw new Error(`no signer proof-artifact base URL in ${WITHDRAWAL_NATIVE_CONFIG_RELPATH}; run setup prep-charts or pass --signer-proof-artifact-base-url`)
      }

      if (!flags['signer-proof-artifact-base-url'] && stagedArtifactUrl) {
        derivedSources.signerProofArtifactBaseUrl = `${WITHDRAWAL_NATIVE_CONFIG_RELPATH} [proof_system].signer_proof_artifact_base_url`
      }

      const signerProofArtifactBaseUrl = artifactInput
        ? normalizeSignerProofArtifactBaseUrl(artifactInput)
        : undefined
      const outDir = path.resolve(flags.out)
      fs.mkdirSync(outDir, {recursive: true})
      for (const stale of ['source-set.toml', 'values-overlay.yaml', 'verifier-registry.toml']) {
        fs.rmSync(path.join(outDir, stale), {force: true})
      }

      fs.writeFileSync(path.join(outDir, 'protocol_context.json'), protocolContextBytes)
      const advanceL2Verifier = mode === 'production' ? resolveProductionVerifier(resolved, outDir) : undefined
      if (!advanceL2Verifier) fs.rmSync(path.join(outDir, ADVANCE_L2_AGG_VERIFYING_KEY_BUNDLE_FILE), {force: true})

      const bundleInput = {
        advanceL2Verifier,
        mode,
        network: config.network,
        preTsukiDirectSign: resolved.intent.preTsukiDirectSign,
        signerProofArtifactBaseUrl,
        signers: signers.map(signer => ({endpoint: signer.endpoint, id: signer.id, publicKey: signer.publicKey})),
        tsoUrl,
      }
      const runtime = signerRuntimePolicyProfile(mode)
      const policy = {
        activeBridgeKeyHash,
        advanceL2Verifier,
        contract: 'attestation_evidence_v2',
        mode,
        network: config.network,
        operatorOwnedPolicy: {
          file: 'attestation-signer.toml',
          productionRequires: [
            'advance_l1_policy.terminal_anchor_sources',
            'advance_l2_policy.ethereum_sources',
            'advance_l2_policy.l2_sources',
            'rotation_policy.allowed_next_bridge_script_hashes',
            'rotation_policy.allowed_next_sequencer_signers',
          ],
        },
        policyMode: runtime.policyMode,
        preTsukiDirectSign: resolved.intent.preTsukiDirectSign,
        protocolContext: {file: 'protocol_context.json', sha256: sha256(protocolContextBytes)},
        schema: BUNDLE_SCHEMA,
        signerProofArtifactBaseUrl,
        signers: bundleInput.signers,
        tsoUrl,
      }
      fs.writeFileSync(path.join(outDir, 'signer-policy.json'), `${JSON.stringify(policy, null, 2)}\n`)
      fs.writeFileSync(path.join(outDir, 'signer-policy.env'), renderSignerPolicyEnv(bundleInput))
      fs.writeFileSync(path.join(outDir, 'PARTNER-COMMANDS.md'), renderPartnerCommands(bundleInput))
      const payloadFiles = [
        'PARTNER-COMMANDS.md',
        'protocol_context.json',
        'signer-policy.env',
        'signer-policy.json',
        ...(advanceL2Verifier ? [ADVANCE_L2_AGG_VERIFYING_KEY_BUNDLE_FILE] : []),
      ]
      writeManifest(outDir, payloadFiles)
      const files = [...payloadFiles, 'signer-policy-manifest.json'].sort()

      const result = {
        activeBridgeKeyHash,
        advanceL2Verifier,
        bundleDir: outDir,
        contract: 'attestation_evidence_v2',
        derivedSources,
        files,
        mode,
        signerCount: signers.length,
        signerPolicyMode: runtime.policyMode,
        signerProofArtifactBaseUrl,
        tsoUrl,
      }
      if (flags.json) json.success(result)
      else this.log(chalk.green(`${mode} V2 signer policy bundle written to ${outDir} for ${signers.length} partner operator(s).`))
    } catch (error) {
      json.error('E804_SIGNER_POLICY_EXPORT_FAILED', error instanceof Error ? error.message : String(error), 'CONFIGURATION', true)
    }
  }
}

export default ExportSignerPolicyCommand
