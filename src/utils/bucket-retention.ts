import {createHash} from 'node:crypto'
import {isDeepStrictEqual} from 'node:util'

import type {AwsCliRunner} from './aws-cli.js'

type Document = Record<string, unknown>
type Aws = Pick<AwsCliRunner, 'json'>
type Store = {bucket: string; keyPrefix: string; region: string}

/** Every deployment store keeps its objects forever. */
export type RetainedStoreKind = 'da' | 'proof' | 'snapshot'

/**
 * Owned lifecycle rule id bases. DA blobs, proof artifacts and bootstrap
 * snapshots are all kept forever: proof retention is a control-plane decision
 * that S3 key prefixes cannot express, and the others are retained by policy.
 */
export const RETENTION_LIFECYCLE_RULE_BASES = {
  da: 'ScrollSdkDaArchiveRetention',
  proof: 'ScrollSdkProofArtifactRetention',
  snapshot: 'ScrollSdkSnapshotRetention',
} as const

const LABELS: Record<RetainedStoreKind, string> = {da: 'DA blobs', proof: 'Proof artifacts', snapshot: 'Bootstrap snapshots'}
// Objects in these classes are served directly to unsigned reads with full durability.
const DIRECTLY_READABLE_STORAGE_CLASSES = new Set(['GLACIER_IR', 'INTELLIGENT_TIERING', 'STANDARD_IA'])

export function retentionLifecycleRule(kind: RetainedStoreKind, bucket: string, keyPrefix: string): Document {
  const id = `${RETENTION_LIFECYCLE_RULE_BASES[kind]}${createHash('sha256').update(`${bucket}/${keyPrefix}`).digest('hex').slice(0, 24)}`
  // Abort-only: it never removes a stored object, only abandoned multipart parts.
  return {AbortIncompleteMultipartUpload: {DaysAfterInitiation: 7}, Filter: {Prefix: keyPrefix ? `${keyPrefix}/` : ''}, ID: id, Status: 'Enabled'}
}

function rulePrefix(rule: Document): string {
  // A tag- or size-only filter can match any key, so it covers the whole bucket.
  const filter = rule.Filter as Document | undefined
  if (filter && typeof filter === 'object') return String(filter.Prefix ?? (filter.And as Document | undefined)?.Prefix ?? '')
  return String(rule.Prefix ?? '')
}

function violation(rule: Document, keyPrefix: string): string | undefined {
  if (rule.Status !== 'Enabled') return undefined
  const ours = keyPrefix ? `${keyPrefix}/` : ''
  const theirs = rulePrefix(rule)
  if (!ours.startsWith(theirs) && !theirs.startsWith(ours)) return undefined
  const expiration = rule.Expiration as Document | undefined
  if (expiration && (expiration.Days !== undefined || expiration.Date !== undefined)) return 'expires current objects'
  // Versioning is what makes an accidental delete recoverable.
  if (rule.NoncurrentVersionExpiration !== undefined) return 'permanently deletes noncurrent versions'
  const transitions = Array.isArray(rule.Transitions) ? rule.Transitions as Document[] : []
  if (transitions.some(item => !DIRECTLY_READABLE_STORAGE_CLASSES.has(String(item.StorageClass)))) return 'moves current objects to a storage class that unsigned reads cannot serve or that reduces durability'
  return undefined
}

/**
 * Keep every other rule verbatim and reconcile only this prefix's owned rule.
 * Refuses any other enabled rule that would expire, permanently delete or
 * archive objects under the prefix.
 */
export function buildRetentionLifecycle(existing: Document, kind: RetainedStoreKind, bucket: string, keyPrefix: string): Document {
  const owned = retentionLifecycleRule(kind, bucket, keyPrefix)
  const rules = (Array.isArray(existing.Rules) ? existing.Rules : []) as Document[]
  for (const rule of rules) {
    const reason = rule.ID === owned.ID ? undefined : violation(rule, keyPrefix)
    if (reason) throw new Error(`Bucket lifecycle rule ${String(rule.ID ?? '<without ID>')} ${reason} under s3://${bucket}/${keyPrefix}; ${LABELS[kind]} are kept forever. Remove or narrow that rule with the bucket owner, then rerun.`)
  }

  const index = rules.findIndex(rule => rule.ID === owned.ID)
  return {...existing, Rules: index === -1 ? [...rules, owned] : rules.map((rule, position) => position === index ? owned : rule)}
}

export function readLifecycleConfiguration(aws: Aws, store: Pick<Store, 'bucket' | 'region'>): Document {
  try {
    const result = aws.json(['s3api', 'get-bucket-lifecycle-configuration', '--bucket', store.bucket], {region: store.region}) ?? {}
    return {...(result.TransitionDefaultMinimumObjectSize === undefined ? {} : {TransitionDefaultMinimumObjectSize: result.TransitionDefaultMinimumObjectSize}), Rules: Array.isArray(result.Rules) ? result.Rules : []}
  } catch (error) {
    if (String(error).includes('NoSuchLifecycleConfiguration')) return {Rules: []}
    throw error
  }
}

export function putLifecycleConfiguration(aws: Aws, store: Pick<Store, 'bucket' | 'region'>, configuration: Document): void {
  // Restate the bucket's minimum-size default; omitting it would reset it.
  const minimum = configuration.TransitionDefaultMinimumObjectSize === undefined ? [] : ['--transition-default-minimum-object-size', String(configuration.TransitionDefaultMinimumObjectSize)]
  aws.json(['s3api', 'put-bucket-lifecycle-configuration', '--bucket', store.bucket, '--lifecycle-configuration', JSON.stringify({Rules: configuration.Rules}), ...minimum], {region: store.region})
  const stored = new Set((readLifecycleConfiguration(aws, store).Rules as Document[]).map(rule => rule.ID))
  const bases = Object.values(RETENTION_LIFECYCLE_RULE_BASES) as string[]
  const missing = (configuration.Rules as Document[]).find(rule => bases.some(base => String(rule.ID).startsWith(base)) && !stored.has(rule.ID))
  if (missing) throw new Error(`Bucket lifecycle readback is missing rule ${String(missing.ID)}`)
}

/** Reconcile without a separate plan; never writes when already correct. */
export function ensureRetentionLifecycle(aws: Aws, kind: RetainedStoreKind, store: Store): {changed: boolean} {
  const before = readLifecycleConfiguration(aws, store)
  const after = buildRetentionLifecycle(before, kind, store.bucket, store.keyPrefix)
  if (isDeepStrictEqual(before, after)) return {changed: false}
  putLifecycleConfiguration(aws, store, after)
  return {changed: true}
}

/** Validate external retention without imposing a CLI-owned lifecycle rule. */
export function checkExistingRetention(aws: Aws, kind: RetainedStoreKind, store: Store): void {
  for (const rule of readLifecycleConfiguration(aws, store).Rules as Document[]) {
    const reason = violation(rule, store.keyPrefix)
    if (reason) throw new Error(`Existing lifecycle rule ${String(rule.ID ?? '<without ID>')} ${reason}; ${LABELS[kind]} must be retained. Fix the lifecycle externally`)
  }
}
