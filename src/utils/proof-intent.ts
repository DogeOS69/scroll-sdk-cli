import * as yaml from 'js-yaml'
import * as fs from 'node:fs'
import * as path from 'node:path'

import type { DeploymentSpec } from '../types/deployment-spec.js'
import type { DogeConfig } from '../types/doge-config.js'

import {
  type PreTsukiDirectSignIntent,
  normalizePreTsukiDirectSignIntent,
} from './pre-tsuki-direct-sign.js'
import {
  type ProofSystemMode,
  normalizeProofSystemMode,
} from './proof-system-mode.js'

export const DEFAULT_DEPLOYMENT_SPEC_FILES = [
  'deployment-spec.yaml',
  'deployment-spec.yml',
] as const

export interface ProofSystemIntent {
  artifactReadBaseUrl?: string
  mode: ProofSystemMode
  /** Temporary, testnet-only Issue #843 recovery posture. */
  preTsukiDirectSign?: PreTsukiDirectSignIntent
  /** Proof release bundle root. Conventional proof-artifacts/ is used when omitted. */
  release?: string
  signerPolicy?: {
    sourceSet?: string
  }
}

export interface ProofIntentSource {
  /**
   * `legacy-doge-config` is accepted only so schema-v1/v2 contracts generated
   * by older CLI releases remain readable. New contracts use `doge-config`.
   */
  kind: 'deployment-spec' | 'doge-config' | 'legacy-doge-config'
  path: string
}

export interface ResolvedProofIntent {
  intent: ProofSystemIntent
  source: ProofIntentSource
}

interface RawProofSystemIntent {
  artifactReadBaseUrl?: unknown
  mode?: unknown
  preTsukiDirectSign?: {
    maxEndBatchHeight?: unknown
  }
  provingMode?: unknown
  release?: unknown
  signerPolicy?: {
    sourceSet?: unknown
  }
}

function optionalNonEmptyString(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${label} must be a non-empty string when set`)
  }

  return value.trim()
}

function normalizeArtifactReadBaseUrl(value: unknown, label: string): string | undefined {
  const normalized = optionalNonEmptyString(value, label)
  if (!normalized) return undefined

  let parsed: URL
  try {
    parsed = new URL(normalized)
  } catch {
    throw new Error(`${label} must be an http(s) URL`)
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error(`${label} must be an http(s) URL`)
  }

  return normalized.replace(/\/+$/, '')
}

export function normalizeProofIntent(
  raw: RawProofSystemIntent | undefined,
  label: string,
): ProofSystemIntent {
  const rawMode = raw?.mode ?? raw?.provingMode ?? 'disabled'
  const mode = normalizeProofSystemMode(rawMode)
  if (!mode) {
    throw new Error(`${label}.mode must be disabled, mock, or production`)
  }

  const preTsukiDirectSign = normalizePreTsukiDirectSignIntent(
    raw?.preTsukiDirectSign,
    `${label}.preTsukiDirectSign`,
  )
  if (preTsukiDirectSign && mode !== 'disabled') {
    throw new Error(`${label}.preTsukiDirectSign requires mode disabled`)
  }

  // Disabled intentionally discards stale proof-only coordinates. This makes
  // mode transitions idempotent and prevents generated output from keeping a
  // disabled deployment coupled to proof infrastructure.
  if (mode === 'disabled') {
    return {
      mode,
      ...(preTsukiDirectSign ? {preTsukiDirectSign} : {}),
    }
  }

  const artifactReadBaseUrl = normalizeArtifactReadBaseUrl(
    raw?.artifactReadBaseUrl,
    `${label}.artifactReadBaseUrl`,
  )
  const release = optionalNonEmptyString(raw?.release, `${label}.release`)
  const sourceSet = optionalNonEmptyString(
    raw?.signerPolicy?.sourceSet,
    `${label}.signerPolicy.sourceSet`,
  )

  return {
    ...(artifactReadBaseUrl ? { artifactReadBaseUrl } : {}),
    mode,
    ...(release ? { release } : {}),
    ...(sourceSet ? { signerPolicy: { sourceSet } } : {}),
  }
}

function discoverDeploymentSpec(deploymentDir: string, explicitSpecPath?: string): string | undefined {
  if (explicitSpecPath) {
    const resolved = path.resolve(deploymentDir, explicitSpecPath)
    if (!fs.existsSync(resolved)) {
      throw new Error(`DeploymentSpec file not found: ${resolved}`)
    }

    return resolved
  }

  const candidates = DEFAULT_DEPLOYMENT_SPEC_FILES
    .map(file => path.resolve(deploymentDir, file))
    .filter(file => fs.existsSync(file))
  if (candidates.length > 1) {
    throw new Error(
      `Multiple conventional DeploymentSpec files found: ${candidates.join(', ')}. `
      + 'Keep one file or select one explicitly with --spec.',
    )
  }

  return candidates[0]
}

function readSpecProofIntent(specPath: string): {
  intent: ProofSystemIntent
} {
  let parsed: unknown
  try {
    parsed = yaml.load(fs.readFileSync(specPath, 'utf8'))
  } catch (error) {
    throw new Error(
      `Failed to load DeploymentSpec ${specPath}: ${error instanceof Error ? error.message : String(error)}`,
    )
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`DeploymentSpec ${specPath} must be a YAML object`)
  }

  const {proofSystem} = (parsed as Partial<DeploymentSpec>)
  return {
    intent: normalizeProofIntent(proofSystem, `${specPath}: proofSystem`),
  }
}

function proofIntentFingerprint(intent: ProofSystemIntent): string {
  return JSON.stringify({
    artifactReadBaseUrl: intent.artifactReadBaseUrl,
    mode: intent.mode,
    preTsukiDirectSignMaxEndBatchHeight:
      intent.preTsukiDirectSign?.maxEndBatchHeight,
    release: intent.release,
    sourceSet: intent.signerPolicy?.sourceSet,
  })
}

/**
 * Select the proof intent provider without making DeploymentSpec mandatory.
 *
 * An explicitly selected or conventional DeploymentSpec is authoritative.
 * Otherwise the existing .data/doge-config.toml remains the source of truth.
 * When both files contain proof intent, disagreement is rejected instead of
 * silently allowing generated files to depend on whichever command ran last.
 */
export function resolveProofIntent(options: {
  deploymentDir?: string
  dogeConfig: Pick<DogeConfig, 'proofSystem'>
  dogeConfigPath: string
  specPath?: string
}): ResolvedProofIntent {
  const deploymentDir = path.resolve(options.deploymentDir || '.')
  const dogeConfigPath = path.resolve(options.dogeConfigPath)
  const dogeRaw = options.dogeConfig.proofSystem as RawProofSystemIntent | undefined
  const dogeIntent = normalizeProofIntent(dogeRaw, `${dogeConfigPath}: proofSystem`)
  const specPath = discoverDeploymentSpec(deploymentDir, options.specPath)

  if (!specPath) {
    return {
      intent: dogeIntent,
      source: { kind: 'doge-config', path: dogeConfigPath },
    }
  }

  const spec = readSpecProofIntent(specPath)
  if (
    dogeRaw !== undefined
    && proofIntentFingerprint(spec.intent) !== proofIntentFingerprint(dogeIntent)
  ) {
    throw new Error(
      `Proof intent conflict: ${specPath} and ${dogeConfigPath} disagree. `
      + 'DeploymentSpec is authoritative when present; update proofSystem there, then regenerate doge-config.toml.',
    )
  }

  return {
    intent: spec.intent,
    source: { kind: 'deployment-spec', path: specPath },
  }
}

export function assertProofIntentOverrideAllowed(options: {
  artifactReadBaseUrl?: string
  mode?: ProofSystemMode
  resolved: ResolvedProofIntent
}): void {
  if (options.resolved.source.kind !== 'deployment-spec') return

  const {intent} = options.resolved
  if (options.mode && options.mode !== intent.mode) {
    throw new Error(
      `--mode ${options.mode} conflicts with proofSystem.mode ${intent.mode} in `
      + `${options.resolved.source.path}; update the DeploymentSpec instead of creating a one-run override.`,
    )
  }

  if (options.artifactReadBaseUrl) {
    const normalized = normalizeArtifactReadBaseUrl(
      options.artifactReadBaseUrl,
      '--proof-artifact-base-url',
    )
    if (normalized !== intent.artifactReadBaseUrl) {
      throw new Error(
        `--proof-artifact-base-url conflicts with proofSystem.artifactReadBaseUrl in `
        + `${options.resolved.source.path}; update the DeploymentSpec instead of creating a one-run override.`,
      )
    }
  }
}
