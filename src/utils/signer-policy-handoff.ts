import fs from 'node:fs'
import path from 'node:path'

import type {DogeConfig} from '../types/doge-config.js'
import type {SignerAdvanceL2VerifierMaterial} from './signer-policy-bundle.js'

import {normalizeExternalHttpBaseUrl} from './attestation-signer-descriptor.js'
import {resolveContractFile, validateProofDeploymentContract} from './proof-deployment-contract.js'
import {readProofMaterials} from './proof-materials.js'
import {normalizeSignerProofArtifactBaseUrl} from './proof-signer-policy-input.js'
import {proofFileHash, proofRegularFile} from './proof-software-release.js'
import {ADVANCE_L2_AGG_VERIFYING_KEY_BUNDLE_FILE, renderPartnerCommands, renderSignerPolicyEnv} from './signer-policy-bundle.js'

export function writeSignerPolicyHandoff(options: {
  config: DogeConfig; contractPath?: string; deploymentDir: string; output: string; protocolContext: string; signerProofArtifactBaseUrl?: string; tsoUrl: string
}): {activeBridgeKeyHash: string; advanceL2Verifier?: SignerAdvanceL2VerifierMaterial; bundleDir: string; files: string[]; signerCount: number} {
  const root = path.resolve(options.deploymentDir)
  const contract = validateProofDeploymentContract(root, options.contractPath)
  const {enforcement, generation, mode} = contract
  if (options.config.network === 'mainnet' && enforcement !== 'enforce') throw new Error('Mainnet signer policy requires enforcement')
  const signers = options.config.attestationSigner?.external?.map(({endpoint, id, publicKey}) => ({endpoint, id, publicKey}))
  if (options.config.attestationSigner?.mode !== 'external' || !signers?.length) throw new Error('External attestation signers are not configured')
  if (generation === 'real' && !contract.inputs) throw new Error('Selected contract has no bound materials receipt; rerun prep-charts with --proof-materials-receipt')
  const context = proofRegularFile(path.resolve(root, options.protocolContext))
  const contextHash = proofFileHash(context)
  if (contract.inputs && contextHash !== contract.inputs.protocolContext.sha256) throw new Error('Protocol context differs from selected proof deployment contract')
  const protocol = JSON.parse(fs.readFileSync(context, 'utf8'))
  const activeBridgeKeyHash = String(protocol?.genesis?.genesis_bridge_key_hash ?? '').toLowerCase().replace(/^(?!0x)/, '0x')
  if (!/^0x[\da-f]{40}$/.test(activeBridgeKeyHash)) throw new Error('Protocol context has no canonical genesis Bridge key hash')
  const tsoUrl = normalizeExternalHttpBaseUrl(options.tsoUrl, 'TSO URL', {remoteNetwork: 'signer operator network'})
  const artifact = options.signerProofArtifactBaseUrl ?? contract.proofArtifactBaseUrl
  if (mode !== 'disabled' && !artifact) throw new Error('Selected proof contract has no signer artifact URL')
  const signerProofArtifactBaseUrl = artifact ? normalizeSignerProofArtifactBaseUrl(artifact) : undefined
  const target = path.resolve(root, options.output)
  if (fs.existsSync(target)) throw new Error('Signer bundle output already exists; select a new versioned directory')
  fs.mkdirSync(path.dirname(target), {recursive: true})
  if (fs.realpathSync(path.dirname(target)) !== path.dirname(target)) throw new Error('Signer bundle output parent contains a symlink')
  const stage = fs.mkdtempSync(path.join(path.dirname(target), '.signer-policy-'))
  try {
    fs.copyFileSync(context, path.join(stage, 'protocol_context.json'))
    let advanceL2Verifier: SignerAdvanceL2VerifierMaterial | undefined
    if (generation === 'real') {
      const materials = readProofMaterials(resolveContractFile(root, contract.inputs!.materials.path), root)
      if (!materials.software.artifacts) throw new Error('Signer handoff requires full real proof materials')
      const vk = proofRegularFile(path.resolve(root, materials.software.artifacts.aggregateVerifyingKey.path))
      const batch = materials.software.identities.batch.appCommitRaw
      const aggregation = materials.software.identities.l2Range.appCommitRaw
      if (!/^0x[\da-f]{128}$/.test(batch) || !/^0x[\da-f]{128}$/.test(aggregation)) throw new Error('Selected verifier commitments are malformed')
      fs.copyFileSync(vk, path.join(stage, ADVANCE_L2_AGG_VERIFYING_KEY_BUNDLE_FILE))
      advanceL2Verifier = {aggVerifyingKeyFile: ADVANCE_L2_AGG_VERIFYING_KEY_BUNDLE_FILE, aggVerifyingKeySha256: `sha256:${proofFileHash(vk)}`, batchProgramCommitmentHex: batch, l2RangeAggregationProgramCommitmentHex: aggregation}
    }

    const input = {advanceL2Verifier, enforcement, generation, mode, network: options.config.network, signerProofArtifactBaseUrl, signers, tsoUrl}
    const policy = {...input, activeBridgeKeyHash, contract: 'attestation_evidence_v2', deployment: {generationId: contract.generationId, inputs: contract.inputs, topologyRevision: contract.topology.bundleRevision}, operatorOwnedPolicy: {file: 'attestation-signer.toml', productionRequires: ['advance_l1_policy.terminal_anchor_sources', 'advance_l2_policy.ethereum_sources', 'advance_l2_policy.l2_sources', 'rotation_policy.allowed_next_bridge_script_hashes', 'rotation_policy.allowed_next_sequencer_signers']},
      policyMode: enforcement,
      protocolContext: {file: 'protocol_context.json', sha256: `sha256:${contextHash}`},
      schema: 'dogeos/attestation-signer-policy-bundle/v2',
    }
    fs.writeFileSync(path.join(stage, 'signer-policy.json'), JSON.stringify(policy, null, 2) + '\n')
    fs.writeFileSync(path.join(stage, 'signer-policy.env'), renderSignerPolicyEnv(input))
    fs.writeFileSync(path.join(stage, 'PARTNER-COMMANDS.md'), renderPartnerCommands(input))
    const files = fs.readdirSync(stage).sort().map(file => ({file, sha256: `sha256:${proofFileHash(path.join(stage, file))}`, sizeBytes: fs.statSync(path.join(stage, file)).size}))
    fs.writeFileSync(path.join(stage, 'signer-policy-manifest.json'), JSON.stringify({files, schema: 'dogeos/attestation-signer-policy-manifest/v1'}, null, 2) + '\n')
    if (proofFileHash(context) !== contextHash || validateProofDeploymentContract(root, options.contractPath).generationId !== contract.generationId) throw new Error('Selected proof inputs changed during signer export')
    fs.renameSync(stage, target)
    return {activeBridgeKeyHash, advanceL2Verifier, bundleDir: target, files: [...files.map(item => item.file), 'signer-policy-manifest.json'].sort(), signerCount: signers.length}
  } finally { fs.rmSync(stage, {force: true, recursive: true}) }
}
