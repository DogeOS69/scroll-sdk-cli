import * as toml from '@iarna/toml'
import fs from 'node:fs'
import path from 'node:path'

import type {DogeConfig} from '../types/doge-config.js'
import type {ProofDeploymentContract} from './proof-deployment-contract.js'

import {DEPLOYMENT_KIT_VERSION, type DeploymentKitRecord, deploymentKitContent, deploymentKitDirectory, verifyDeploymentKit} from './deployment-kit.js'
import {privateWrite} from './preparation-io.js'
import {deriveTsoUrl} from './signer-policy-derivation.js'

/** `[attestationSigner.deploymentKit]`: the operator's assertion that this kit is published at `url`. */
export interface DeploymentKitPublication {
  manifestSha256: string
  path: string
  url: string
  version: string
}

/** Every readiness blocker about the kit starts with this, so publish can tolerate a pending kit. */
export const DEPLOYMENT_KIT_BLOCKER = 'Deployment kit:'
export const DEPLOYMENT_KIT_PROTOCOL_CONTEXT = '.data/protocol_context.json'

/** Readiness blockers other than a pending kit: a new proof configuration's kit is published after activation. */
export function withoutPendingDeploymentKit(blockers: string[]): string[] {
  return blockers.filter(blocker => !blocker.startsWith(DEPLOYMENT_KIT_BLOCKER))
}

function publicationUrl(value: unknown): string {
  let url: URL
  try {url = new URL(String(value))} catch {throw new Error('the publication URL is not a URL')}
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('the publication URL must be https without credentials')
  return url.href
}

/**
 * Record that the kit is published, in the deployment's doge-config, keeping
 * every other TOML field. The kit must be the canonical directory under `root`.
 */
export function recordDeploymentKitPublication(root: string, configPath: string, kit: DeploymentKitRecord, url: string): DeploymentKitPublication {
  if (kit.kitDir !== path.join(path.resolve(root), deploymentKitDirectory(kit.kitVersion))) throw new Error('Only the canonical deployment-kit-<version> directory can be recorded')
  const record = {manifestSha256: kit.manifestSha256, path: deploymentKitDirectory(kit.kitVersion), url: publicationUrl(url), version: kit.kitVersion}
  const document = toml.parse(fs.readFileSync(configPath, 'utf8'))
  if (!document.attestationSigner || typeof document.attestationSigner !== 'object') throw new Error('doge-config has no [attestationSigner] to record the deployment kit in')
  ;(document.attestationSigner as toml.JsonMap).deploymentKit = record as unknown as toml.JsonMap
  privateWrite(configPath, toml.stringify(document))
  return record
}

/**
 * Offline kit readiness for an enforcing contract: a well-formed publication
 * record whose kit is exactly what the current deployment inputs produce.
 * Read-only. The TSO URL comes from `config.toml [ingress].TSO_HOST` in `root`.
 */
export function deploymentKitBlockers(root: string, contract: ProofDeploymentContract, config: DogeConfig): string[] {
  if (contract.enforcement !== 'enforce') return []
  const record = config.attestationSigner?.deploymentKit
  if (!record) return [`${DEPLOYMENT_KIT_BLOCKER} no published kit is recorded; export it, publish it unchanged and record its URL`]
  try {
    if (!DEPLOYMENT_KIT_VERSION.test(String(record.version)) || !/^[\da-f]{64}$/.test(String(record.manifestSha256)) || record.path !== deploymentKitDirectory(record.version)) throw new Error('the recorded kit fields are malformed')
    publicationUrl(record.url)
    const tsoUrl = deriveTsoUrl(path.join(root, 'config.toml'))?.value
    if (!tsoUrl) throw new Error('config.toml has no [ingress].TSO_HOST')
    const content = deploymentKitContent({config, contract, deploymentDir: root, protocolContext: DEPLOYMENT_KIT_PROTOCOL_CONTEXT, tsoUrl})
    if (content.version !== record.version || content.manifestSha256 !== record.manifestSha256) throw new Error(`the recorded kit ${record.version} is not the kit for the current inputs (${content.version}); export and publish the new kit`)
    verifyDeploymentKit(path.join(root, record.path), content)
    return []
  } catch (error) {
    return [`${DEPLOYMENT_KIT_BLOCKER} ${error instanceof Error ? error.message : String(error)}`]
  }
}
