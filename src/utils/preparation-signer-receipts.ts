import * as toml from '@iarna/toml'
import {createHash} from 'node:crypto'
import fs from 'node:fs'

import {loadDogeConfigWithSelection} from './doge-config.js'
import {AwaitingInput, localPath, privateWrite, writeJson} from './preparation-io.js'
import {validateProofDeploymentContract} from './proof-deployment-contract.js'
import {proofEnforcementReadiness} from './proof-enforcement-readiness.js'
import {proofFileHash, proofRegularFile} from './proof-software-release.js'

/** Mutable inbox stays outside managed fingerprints. Only verified receipts become managed inputs. */
export async function importSignerReceipts(root: string): Promise<void> {
  const contract = validateProofDeploymentContract(root)
  const configPath = localPath(root, '.data/doge-config.toml')
  const {config} = await loadDogeConfigWithSelection(configPath, 'setup apply')
  const active = config.attestationSigner?.activeSignerIds ?? []
  const signers = config.attestationSigner?.external ?? []
  if (active.length === 0 || active.some(id => !signers.some(signer => signer.id === id))) throw new Error('No resolved active signer set for partner validation')
  const bundle = 'signer-policy-bundle/signer-policy-manifest.json'
  const manifest = proofRegularFile(localPath(root, bundle))
  const inbox = '.scrollsdk/inputs/signer-receipts'
  const requests = active.map((id, index) => ({file: `${index + 1}.json`, publicKey: signers.find(signer => signer.id === id)!.publicKey, signerId: id}))
  const manifestSha256 = proofFileHash(manifest)
  writeJson(localPath(root, `${inbox}/request.json`), {bundleDirectory: 'signer-policy-bundle', bundleManifestSha256: `sha256:${manifestSha256}`, instructions: 'Send the signer-policy-bundle to partners. Each partner validates their final enforce configuration against the selected release and returns a policy-validation receipt from that verification. Save each receipt at its listed filename, then rerun setup apply.', receipts: requests, schema: 'scrollsdk/signer-validation-request/v1'})
  const missing = requests.filter(item => !fs.existsSync(localPath(root, `${inbox}/${item.file}`)))
  if (missing.length > 0) throw new AwaitingInput({file: localPath(root, `${inbox}/request.json`), message: `Waiting for partner policy-validation receipts: ${missing.map(item => item.signerId).join(', ')}. See request.json for filenames and handoff instructions, then rerun apply`})
  const receipts = requests.map(item => {
    const relative = `${inbox}/${item.file}`
    const file = proofRegularFile(localPath(root, relative), 4 * 1024 * 1024)
    return {path: relative, sha256: proofFileHash(file)}
  })
  config.attestationSigner!.policyValidation = {bundleManifest: {path: bundle, sha256: manifestSha256}, receipts}
  const readiness = proofEnforcementReadiness(root, contract, config)
  if (!readiness.ready) throw new Error(`Partner validation cannot be accepted:\n- ${readiness.blockers.join('\n- ')}`)
  // Copy the exact checked bytes; a concurrent inbox change cannot silently enter managed state.
  const contents = receipts.map(reference => {
    const content = fs.readFileSync(localPath(root, reference.path))
    return {content, reference}
  })
  if (contents.some(({content, reference}) => createHash('sha256').update(content).digest('hex') !== reference.sha256)) throw new Error('Partner receipt changed during import; retry apply')
  const managed = contents.map(({content, reference}, index) => {
    const destination = `.data/signer-policy-validation/${index + 1}.json`
    privateWrite(localPath(root, destination), content)
    return {...reference, path: destination}
  })
  config.attestationSigner!.policyValidation.receipts = managed
  // Preserve every unrelated TOML field, including fields unknown to the typed loader.
  const document = toml.parse(fs.readFileSync(configPath, 'utf8'))
  const attestation = document.attestationSigner as toml.JsonMap
  attestation.policyValidation = config.attestationSigner!.policyValidation as unknown as toml.JsonMap
  privateWrite(configPath, toml.stringify(document))
}
