import * as fs from 'node:fs'
import * as path from 'node:path'

import type {DeploymentSpec} from '../types/deployment-spec.js'
import type {PreTsukiDirectSignIntent} from './pre-tsuki-direct-sign.js'
import type {ProofSystemMode} from './proof-system-mode.js'

import {
  loadDeploymentSpec,
  resolveDeploymentSpecEnvRefs,
  validateDeploymentSpec,
} from './deployment-spec-generator.js'

export const DEFAULT_DEPLOYMENT_SPEC_FILES = [
  'deployment-spec.yaml',
  'deployment-spec.yml',
] as const

export interface ProofTopologyIntent {
  mode: ProofSystemMode
  preTsukiDirectSign?: PreTsukiDirectSignIntent
}

export interface ProofIntentSource {
  kind: 'deployment-spec'
  path: string
}

export interface ResolvedProofIntent {
  deploymentSpec: DeploymentSpec
  intent: ProofTopologyIntent
  source: ProofIntentSource
}

function discoverDeploymentSpec(deploymentDir: string, explicitSpecPath?: string): string {
  if (explicitSpecPath) {
    const resolved = path.resolve(deploymentDir, explicitSpecPath)
    if (!fs.existsSync(resolved)) throw new Error(`DeploymentSpec file not found: ${resolved}`)
    return resolved
  }

  const candidates = DEFAULT_DEPLOYMENT_SPEC_FILES
    .map(file => path.resolve(deploymentDir, file))
    .filter(file => fs.existsSync(file))
  if (candidates.length === 0) {
    throw new Error(
      `proof topology requires deployment-spec.yaml or deployment-spec.yml in ${deploymentDir}; `
      + 'pass --spec when the DeploymentSpec has another name',
    )
  }

  if (candidates.length > 1) {
    throw new Error(
      `Multiple conventional DeploymentSpec files found: ${candidates.join(', ')}. `
      + 'Keep one file or select one explicitly with --spec.',
    )
  }

  return candidates[0]
}

export function resolveProofIntent(options: {
  deploymentDir?: string
  specPath?: string
}): ResolvedProofIntent {
  const deploymentDir = path.resolve(options.deploymentDir || '.')
  const specPath = discoverDeploymentSpec(deploymentDir, options.specPath)
  const deploymentSpec = resolveDeploymentSpecEnvRefs(loadDeploymentSpec(specPath))
  const validation = validateDeploymentSpec(deploymentSpec)
  if (!validation.valid) {
    throw new Error(
      `${specPath}: DeploymentSpec validation failed:\n${validation.errors
        .map(error => `- ${error.path}: ${error.message}`)
        .join('\n')}`,
    )
  }

  const topology = deploymentSpec.proofTopology
  if (!topology) {
    throw new Error(`${specPath}: proofTopology is required`)
  }

  return {
    deploymentSpec,
    intent: {
      mode: topology.mode,
      ...(topology.recovery
        ? {
            preTsukiDirectSign: {
              maxEndBatchHeight: topology.recovery.preTsukiDirectSignMaxEndBatchHeight,
            },
          }
        : {}),
    },
    source: {kind: 'deployment-spec', path: specPath},
  }
}
