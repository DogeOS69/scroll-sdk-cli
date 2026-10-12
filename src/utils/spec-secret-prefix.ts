import * as toml from '@iarna/toml'
import * as yaml from 'js-yaml'
import fs from 'node:fs'
import path from 'node:path'

import type {DeploymentSpec} from '../types/deployment-spec.js'
import type {DogeConfig} from '../types/doge-config.js'

function validPrefix(prefix: string): string {
  if (!prefix || !/^[\w+./=@-]+$/.test(prefix) || prefix.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('AWS Secret prefix must be a nonempty path without empty or relative segments')
  return prefix
}

/** One namespace for generated references and uploads, isolated by deployment. */
export function specAwsSecretPrefix(spec: DeploymentSpec): string {
  const infrastructure = spec.infrastructure.aws?.secretsPrefix
  const upload = spec.preparation?.secretUpload?.provider === 'aws' ? spec.preparation.secretUpload.awsPrefix : undefined
  if (infrastructure && upload && infrastructure !== upload) throw new Error('preparation.secretUpload.awsPrefix must match infrastructure.aws.secretsPrefix')
  if (infrastructure || upload) return validPrefix(infrastructure || upload!)
  if (spec.infrastructure.provider !== 'aws' && !(spec.infrastructure.provider === 'local' && spec.infrastructure.local?.useK8sSecrets === false) && spec.preparation?.secretUpload?.provider !== 'aws') return 'local'
  const cluster = spec.infrastructure.aws?.eksClusterName
  if (!cluster || !spec.metadata?.name) throw new Error('AWS Secrets require infrastructure.aws.eksClusterName and metadata.name, or an explicit infrastructure.aws.secretsPrefix')
  return validPrefix(`dogeos/${cluster}/${spec.infrastructure.namespace ?? 'default'}/${spec.metadata.name}`)
}

/** Standalone commands use the frozen generated destination, then the local spec. */
export function savedAwsSecretPrefix(root = process.cwd()): string | undefined {
  const configFile = path.join(root, '.data/doge-config.toml')
  if (fs.existsSync(configFile)) {
    let store: DogeConfig['ethereumRpcSecretStore']
    try {store = (toml.parse(fs.readFileSync(configFile, 'utf8')) as unknown as DogeConfig).ethereumRpcSecretStore} catch {throw new Error('Cannot read private Secret destination configuration (contents omitted)')}
    if (store?.provider === 'aws') return validPrefix(store.prefix)
  }

  const specFile = path.join(root, 'deployment-spec.yaml')
  if (fs.existsSync(specFile)) {
    let spec: DeploymentSpec
    try {spec = yaml.load(fs.readFileSync(specFile, 'utf8')) as DeploymentSpec} catch {throw new Error('Cannot read deployment Secret destination (contents omitted)')}
    if (spec?.infrastructure?.provider === 'aws' || (spec?.infrastructure?.provider === 'local' && spec.infrastructure.local?.useK8sSecrets === false) || spec?.preparation?.secretUpload?.provider === 'aws') return specAwsSecretPrefix(spec)
  }

  return undefined
}

export function resolveAwsSecretPrefix(explicit?: string, root = process.cwd()): string {
  const prefix = explicit || savedAwsSecretPrefix(root)
  if (!prefix) throw new Error('Set --aws-prefix or generate deployment configuration with an AWS Secret destination; refusing a shared default prefix')
  return validPrefix(prefix)
}

export function remoteSecretPrefix(key: string): string | undefined {
  const boundary = key.lastIndexOf('/')
  return boundary > 0 ? key.slice(0, boundary) : undefined
}
