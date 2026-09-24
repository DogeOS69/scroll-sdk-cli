/** Public deployment inputs for the standalone dstack-controller chart. */
export interface DstackControllerConfig {
  auth?: {existingSecret?: string; key?: string}
  credentialSecrets?: Array<{name: string; secretName: string}>
  database?: {existingSecret?: string; key?: string; type?: 'postgresql' | 'sqlite'}
  /** Opt in by adding this block; false skips generation without deleting existing files. */
  enabled?: boolean
  fullnameOverride?: string
  /** Custom images must specify their own immutable digest. */
  image?: {digest: string; pullPolicy?: 'Always' | 'IfNotPresent' | 'Never'; repository: string; tag?: string}
  ingress?: {
    annotations?: Record<string, string>
    className?: string
    enabled?: boolean
    hosts?: string[]
    tls?: Array<{hosts: string[]; secretName: string}>
  }
  nodeSelector?: Record<string, string>
  persistence?: {
    accessModes?: Array<'ReadWriteMany' | 'ReadWriteOnce' | 'ReadWriteOncePod'>
    existingClaim?: string
    retain?: boolean
    size?: string
    /** Omit to use the cluster default; empty string requests no StorageClass. */
    storageClass?: string
  }
  podAnnotations?: Record<string, string>
  replicaCount?: 0 | 1
  resources?: {limits?: Record<string, string>; requests?: Record<string, string>}
  serverConfig?: {existingSecret?: string; key?: string}
  serviceAccount?: {
    annotations?: Record<string, string>
    automountServiceAccountToken?: boolean
    create?: boolean
    name?: string
  }
  tolerations?: Array<{
    effect?: 'NoExecute' | 'NoSchedule' | 'PreferNoSchedule'
    key?: string
    operator?: 'Equal' | 'Exists'
    tolerationSeconds?: number
    value?: string
  }>
}
