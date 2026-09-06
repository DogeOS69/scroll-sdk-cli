import * as toml from '@iarna/toml'
import * as fs from 'node:fs'
import * as path from 'node:path'

import type {DogeConfig} from '../types/doge-config.js'

import {normalizeProofBucketName, normalizeProofKeyPrefix} from './proof-aws-provisioner.js'

export const DEFAULT_DOGE_CONFIG_PATH = '.data/doge-config.toml'

export interface SharedArtifactStore {
  bucket: string
  endpointUrl?: string
  forcePathStyle: boolean
  keyPrefix: string
  publicBaseUrl?: string
  region: string
}

function configuredString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function configuredBoolean(value: unknown): boolean {
  return value === true || (typeof value === 'string' && value.trim().toLowerCase() === 'true')
}

/**
 * Resolve the one S3 namespace shared by raw Ethereum DA blobs and proof
 * artifacts. dogeos-core's submitter has one `[s3]` client; the segmentation
 * sidecar is a logical key namespace beneath that same bucket/key prefix.
 */
export function sharedArtifactStoreFromDogeConfig(
  dogeConfig: Pick<DogeConfig, 'ethereumDa'>,
  label = 'doge-config ethereumDa.blobArchive.s3',
): SharedArtifactStore {
  const s3 = dogeConfig.ethereumDa?.blobArchive?.s3
  if (!s3 || !configuredBoolean(s3.enabled)) {
    throw new Error(
      `${label} must be enabled before proof AWS setup; configure the canonical Ethereum DA S3 archive first`,
    )
  }

  const bucket = configuredString(s3.bucket)
  const region = configuredString(s3.region)
  const keyPrefix = configuredString(s3.keyPrefix)
  if (!bucket || !region || !keyPrefix) {
    throw new Error(`${label} must define bucket, region, and a non-empty keyPrefix`)
  }

  return {
    bucket: normalizeProofBucketName(bucket),
    ...(configuredString(s3.endpointUrl) ? {endpointUrl: configuredString(s3.endpointUrl)} : {}),
    forcePathStyle: configuredBoolean(s3.forcePathStyle),
    keyPrefix: normalizeProofKeyPrefix(keyPrefix),
    ...(configuredString(s3.publicBaseUrl) ? {publicBaseUrl: configuredString(s3.publicBaseUrl)} : {}),
    region,
  }
}

export function readSharedArtifactStore(
  deploymentDir = '.',
  dogeConfigPath = DEFAULT_DOGE_CONFIG_PATH,
): {configPath: string; store: SharedArtifactStore} {
  const configPath = path.isAbsolute(dogeConfigPath)
    ? dogeConfigPath
    : path.resolve(deploymentDir, dogeConfigPath)
  if (!fs.existsSync(configPath)) {
    throw new Error(
      `DogeOS config not found: ${configPath}; configure ethereumDa.blobArchive.s3 before proof AWS setup`,
    )
  }

  let parsed: DogeConfig
  try {
    parsed = toml.parse(fs.readFileSync(configPath, 'utf8')) as unknown as DogeConfig
  } catch (error) {
    throw new Error(`${configPath}: failed to parse doge-config: ${error instanceof Error ? error.message : String(error)}`)
  }

  return {configPath, store: sharedArtifactStoreFromDogeConfig(parsed, configPath)}
}

export function assertTopologyUsesSharedArtifactStore(input: {
  bucket?: string
  keyPrefix?: string
  region?: string
}, shared: SharedArtifactStore, label = 'proof topology'): void {
  for (const [field, actual, expected] of [
    ['bucket', input.bucket, shared.bucket],
    ['region', input.region, shared.region],
    ['keyPrefix', input.keyPrefix, shared.keyPrefix],
  ] as const) {
    if (actual !== expected) {
      throw new Error(
        `${label} artifact ${field} (${String(actual)}) does not match canonical `
        + `ethereumDa.blobArchive.s3 (${expected})`,
      )
    }
  }
}
