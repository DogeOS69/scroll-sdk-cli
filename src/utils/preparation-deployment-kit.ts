import fs from 'node:fs'
import path from 'node:path'

import {type DeploymentKitRecord, writeDeploymentKit} from './deployment-kit.js'
import {DEPLOYMENT_KIT_PROTOCOL_CONTEXT, recordDeploymentKitPublication} from './deployment-kit-record.js'
import {loadDogeConfigWithSelection} from './doge-config.js'
import {AwaitingInput, localPath, writeJson} from './preparation-io.js'
import {validateProofDeploymentContract} from './proof-deployment-contract.js'
import {resolveProofIntent, validateProofIntentBinding} from './proof-intent.js'
import {deriveTsoUrl} from './signer-policy-derivation.js'

const INBOX = '.scrollsdk/inputs/deployment-kit'

/**
 * The `deployment-kit` step: the same writer and inputs as `setup
 * export-deployment-kit`. Unchanged inputs give the same kit, so a rerun is a
 * no-op; changed inputs give a new version in a new directory.
 */
export async function exportPreparationDeploymentKit(root: string): Promise<{configPath: string; kit: DeploymentKitRecord}> {
  const {config, configPath} = await loadDogeConfigWithSelection(localPath(root, '.data/doge-config.toml'), 'setup apply')
  const intent = resolveProofIntent({deploymentDir: root, dogeConfig: config, dogeConfigPath: configPath, required: true})!
  validateProofIntentBinding(validateProofDeploymentContract(root), intent)
  const tsoUrl = deriveTsoUrl(localPath(root, 'config.toml'))?.value
  if (!tsoUrl) throw new Error('config.toml has no [ingress].TSO_HOST')
  return {configPath, kit: writeDeploymentKit({config, deploymentDir: root, protocolContext: DEPLOYMENT_KIT_PROTOCOL_CONTEXT, tsoUrl})}
}

/**
 * The `deployment-kit-published` step: wait until the operator has published
 * the current kit unchanged and saved its URL and manifest SHA-256 in
 * `.scrollsdk/inputs/deployment-kit/published.json`, then record it.
 */
export async function awaitDeploymentKitPublication(root: string): Promise<void> {
  const {configPath, kit} = await exportPreparationDeploymentKit(root)
  const kitDirectory = path.relative(root, kit.kitDir)
  writeJson(localPath(root, `${INBOX}/request.json`), {
    instructions: `Publish ${kitDirectory}/ (or an archive of it) unchanged at a new immutable https URL and record that URL with this manifest SHA-256 on the deployment's governance record. Then save {"url": "<https URL>", "manifest_sha256": "${kit.manifestSha256}"} as published.json next to this file and rerun apply.`,
    kitDirectory,
    kitVersion: kit.kitVersion,
    manifestSha256: kit.manifestSha256,
    schema: 'scrollsdk/deployment-kit-publication-request/v1',
  })
  const file = localPath(root, `${INBOX}/published.json`)
  const waiting = (message: string) => new AwaitingInput({file, message})
  if (!fs.existsSync(file)) throw waiting(`Waiting for the deployment kit ${kit.kitVersion} to be published; see request.json`)
  let published: {manifest_sha256?: unknown; url?: unknown}
  try {published = JSON.parse(fs.readFileSync(file, 'utf8'))} catch {throw waiting('published.json is not valid JSON')}
  if (published.manifest_sha256 !== kit.manifestSha256) throw waiting(`published.json names another kit; the current kit ${kit.kitVersion} has manifest SHA-256 ${kit.manifestSha256}`)
  try {recordDeploymentKitPublication(root, configPath, kit, String(published.url))} catch (error) {throw waiting(`published.json: ${error instanceof Error ? error.message : String(error)}`)}
}
