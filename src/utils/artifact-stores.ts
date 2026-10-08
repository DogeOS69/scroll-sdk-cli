import * as toml from '@iarna/toml'
import * as fs from 'node:fs'
import * as path from 'node:path'

import type {DogeConfig} from '../types/doge-config.js'

import {normalizeProofBucketName, normalizeProofKeyPrefix} from './proof-aws-provisioner.js'

export const DEFAULT_DOGE_CONFIG_PATH = '.data/doge-config.toml'

/**
 * The three deployment buckets, each with its own writers and read policy:
 * - da: the Ethereum DA blob archive (ethereumDa.blobArchive.s3), written only
 *   by eth-da-submitter and read publicly behind a kill switch;
 * - proof: proof artifacts (proofArtifacts.s3), the only artifact origin
 *   signers and CubeSigner allow; eth-da-submitter writes only its
 *   segmentation sidecar namespace here;
 * - snapshot: bootstrap snapshots (snapshots.s3), written by the deploy role.
 */
export type ArtifactStoreKind = 'da' | 'proof' | 'snapshot'

export interface ArtifactStore {
  bucket: string
  endpointUrl?: string
  forcePathStyle: boolean
  keyPrefix: string
  publicBaseUrl?: string
  region: string
}

type S3Section = {
  bucket?: string
  enabled?: boolean | string
  endpointUrl?: string
  forcePathStyle?: boolean | string
  keyPrefix?: string
  publicBaseUrl?: string
  region?: string
}

export const ARTIFACT_STORE_SECTIONS: Record<ArtifactStoreKind, string> = {
  da: 'ethereumDa.blobArchive.s3',
  proof: 'proofArtifacts.s3',
  snapshot: 'snapshots.s3',
}

function configuredString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function configuredBoolean(value: unknown): boolean {
  return value === true || (typeof value === 'string' && value.trim().toLowerCase() === 'true')
}

function section(dogeConfig: Pick<DogeConfig, 'ethereumDa' | 'proofArtifacts' | 'snapshots'>, kind: ArtifactStoreKind): S3Section | undefined {
  if (kind === 'da') {
    const s3 = dogeConfig.ethereumDa?.blobArchive?.s3
    return s3 && configuredBoolean(s3.enabled) ? s3 : undefined
  }

  return kind === 'proof' ? dogeConfig.proofArtifacts?.s3 : dogeConfig.snapshots?.s3
}

export function artifactStoreFromDogeConfig(
  dogeConfig: Pick<DogeConfig, 'ethereumDa' | 'proofArtifacts' | 'snapshots'>,
  kind: ArtifactStoreKind,
  label = `doge-config ${ARTIFACT_STORE_SECTIONS[kind]}`,
): ArtifactStore {
  const s3 = section(dogeConfig, kind)
  const bucket = configuredString(s3?.bucket)
  const region = configuredString(s3?.region)
  const keyPrefix = configuredString(s3?.keyPrefix)
  if (!bucket || !region || !keyPrefix) {
    throw new Error(`${label} must ${kind === 'da' ? 'be enabled and ' : ''}define bucket, region, and a non-empty keyPrefix`)
  }

  return {
    bucket: normalizeProofBucketName(bucket),
    ...(configuredString(s3?.endpointUrl) ? {endpointUrl: configuredString(s3?.endpointUrl)} : {}),
    forcePathStyle: configuredBoolean(s3?.forcePathStyle),
    keyPrefix: normalizeProofKeyPrefix(keyPrefix),
    ...(configuredString(s3?.publicBaseUrl) ? {publicBaseUrl: configuredString(s3?.publicBaseUrl)} : {}),
    region,
  }
}

/** The proof artifact store: coordinator/WP artifact_store and the signer artifact origin. */
export function proofArtifactStoreFromDogeConfig(
  dogeConfig: Pick<DogeConfig, 'ethereumDa' | 'proofArtifacts' | 'snapshots'>,
  label?: string,
): ArtifactStore {
  return artifactStoreFromDogeConfig(dogeConfig, 'proof', label)
}

function readDogeConfig(kind: ArtifactStoreKind, deploymentDir: string, dogeConfigPath: string): {configPath: string; parsed: DogeConfig} {
  const configPath = path.isAbsolute(dogeConfigPath)
    ? dogeConfigPath
    : path.resolve(deploymentDir, dogeConfigPath)
  if (!fs.existsSync(configPath)) {
    throw new Error(`DogeOS config not found: ${configPath}; configure ${ARTIFACT_STORE_SECTIONS[kind]} first`)
  }

  try {
    return {configPath, parsed: toml.parse(fs.readFileSync(configPath, 'utf8')) as unknown as DogeConfig}
  } catch (error) {
    throw new Error(`${configPath}: failed to parse doge-config: ${error instanceof Error ? error.message : String(error)}`)
  }
}

export function readArtifactStore(
  kind: ArtifactStoreKind,
  deploymentDir = '.',
  dogeConfigPath = DEFAULT_DOGE_CONFIG_PATH,
): {configPath: string; store: ArtifactStore} {
  const {configPath, parsed} = readDogeConfig(kind, deploymentDir, dogeConfigPath)
  return {configPath, store: artifactStoreFromDogeConfig(parsed, kind, `${configPath} ${ARTIFACT_STORE_SECTIONS[kind]}`)}
}

/** Like readArtifactStore, but undefined when the store's section is absent. */
export function readOptionalArtifactStore(
  kind: ArtifactStoreKind,
  deploymentDir = '.',
  dogeConfigPath = DEFAULT_DOGE_CONFIG_PATH,
): ArtifactStore | undefined {
  const {configPath, parsed} = readDogeConfig(kind, deploymentDir, dogeConfigPath)
  return section(parsed, kind) ? artifactStoreFromDogeConfig(parsed, kind, `${configPath} ${ARTIFACT_STORE_SECTIONS[kind]}`) : undefined
}

export function readProofArtifactStore(
  deploymentDir = '.',
  dogeConfigPath = DEFAULT_DOGE_CONFIG_PATH,
): {configPath: string; store: ArtifactStore} {
  return readArtifactStore('proof', deploymentDir, dogeConfigPath)
}

export function assertTopologyUsesProofArtifactStore(input: {
  bucket?: string
  keyPrefix?: string
  region?: string
}, store: ArtifactStore, label = 'proof topology'): void {
  for (const [field, actual, expected] of [
    ['bucket', input.bucket, store.bucket],
    ['region', input.region, store.region],
    ['keyPrefix', input.keyPrefix, store.keyPrefix],
  ] as const) {
    if (actual !== expected) {
      throw new Error(
        `${label} artifact ${field} (${String(actual)}) does not match canonical `
        + `proofArtifacts.s3 (${expected})`,
      )
    }
  }
}
