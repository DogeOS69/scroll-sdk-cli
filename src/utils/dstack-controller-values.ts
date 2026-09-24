import * as yaml from 'js-yaml'

import type {DstackControllerConfig} from '../types/dstack-controller.js'

export const DSTACK_CONTROLLER_VALUES_FILE = 'dstack-controller-production.yaml'
export const DSTACK_CONTROLLER_IMAGE = {
  digest: 'sha256:a502b38014dc9730ad712f60c067b84a00a4cf091982b81f9982fdc60ac6852b',
  pullPolicy: 'IfNotPresent',
  repository: 'dstackai/dstack',
  tag: '0.21.5',
} as const

type Mapping = Record<string, unknown>

function mapping(value: unknown, label: string, keys?: string[]): Mapping {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be a mapping`)
  const result = value as Mapping
  if (keys && Object.keys(result).some(key => !keys.includes(key))) {
    throw new Error(`${label} contains unsupported fields; credentials must use existing Secret references`)
  }

  return result
}

function text(value: unknown, label: string, allowEmpty = false): void {
  if (typeof value !== 'string' || (!allowEmpty && !value.trim())) throw new Error(`${label} must be ${allowEmpty ? 'a string' : 'a non-empty string'}`)
}

function bool(value: unknown, label: string): void {
  if (typeof value !== 'boolean') throw new Error(`${label} must be a boolean`)
}

function strings(value: unknown, label: string): void {
  for (const item of Object.values(mapping(value, label))) text(item, label, true)
}

function validateImage(config: Mapping, root: string): void {
  if (config.image !== undefined) {
    const image = mapping(config.image, `${root}.image`, ['digest', 'pullPolicy', 'repository', 'tag'])
    text(image.repository, `${root}.image.repository`)
    if (typeof image.digest !== 'string' || !/^sha256:[\da-f]{64}$/.test(image.digest)) {
      throw new Error(`${root}.image.digest must be an immutable sha256 digest`)
    }

    if (image.tag !== undefined) text(image.tag, `${root}.image.tag`, true)
    if (image.pullPolicy !== undefined && !['Always', 'IfNotPresent', 'Never'].includes(image.pullPolicy as string)) {
      throw new Error(`${root}.image.pullPolicy is invalid`)
    }
  }
}

function validatePersistence(config: Mapping, root: string): void {
  if (config.persistence !== undefined) {
    const persistence = mapping(config.persistence, `${root}.persistence`, ['accessModes', 'existingClaim', 'retain', 'size', 'storageClass'])
    for (const field of ['existingClaim', 'size', 'storageClass']) {
      if (persistence[field] !== undefined) text(persistence[field], `${root}.persistence.${field}`, field !== 'size')
    }

    if (persistence.retain !== undefined) bool(persistence.retain, `${root}.persistence.retain`)
    if (persistence.accessModes !== undefined && (!Array.isArray(persistence.accessModes) || persistence.accessModes.length === 0
      || persistence.accessModes.some(mode => !['ReadWriteMany', 'ReadWriteOnce', 'ReadWriteOncePod'].includes(mode)))) {
      throw new Error(`${root}.persistence.accessModes is invalid`)
    }
  }
}

function validateCredentialSecrets(config: Mapping, root: string): void {
  if (config.credentialSecrets !== undefined) {
    if (!Array.isArray(config.credentialSecrets)) throw new Error(`${root}.credentialSecrets must be an array`)
    const seen = new Set<string>()
    for (const value of config.credentialSecrets) {
      const ref = mapping(value, `${root}.credentialSecrets`, ['name', 'secretName'])
      if (typeof ref.name !== 'string' || ref.name.length > 51 || !/^[\da-z]([\da-z-]*[\da-z])?$/.test(ref.name) || seen.has(ref.name)) {
        throw new Error(`${root}.credentialSecrets names must be unique DNS labels of at most 51 characters`)
      }

      seen.add(ref.name)
      text(ref.secretName, `${root}.credentialSecrets.secretName`)
    }
  }
}

function validateIngress(config: Mapping, root: string): void {
  if (config.ingress !== undefined) {
    const ingress = mapping(config.ingress, `${root}.ingress`, ['annotations', 'className', 'enabled', 'hosts', 'tls'])
    if (ingress.enabled !== undefined) bool(ingress.enabled, `${root}.ingress.enabled`)
    if (ingress.className !== undefined) text(ingress.className, `${root}.ingress.className`, true)
    if (ingress.annotations !== undefined) strings(ingress.annotations, `${root}.ingress.annotations`)
    const hosts = (value: unknown, label: string) => {
      if (!Array.isArray(value)) throw new Error(`${label} must be an array`)
      for (const host of value) text(host, label)
    }

    if (ingress.hosts !== undefined) hosts(ingress.hosts, `${root}.ingress.hosts`)
    if (ingress.enabled === true && !(ingress.hosts as undefined | unknown[])?.length) throw new Error(`${root}.ingress.hosts is required when ingress is enabled`)
    if (ingress.tls !== undefined) {
      if (!Array.isArray(ingress.tls)) throw new Error(`${root}.ingress.tls must be an array`)
      for (const value of ingress.tls) {
        const tls = mapping(value, `${root}.ingress.tls`, ['hosts', 'secretName'])
        text(tls.secretName, `${root}.ingress.tls.secretName`)
        hosts(tls.hosts, `${root}.ingress.tls.hosts`)
        if ((tls.hosts as unknown[]).length === 0) throw new Error(`${root}.ingress.tls.hosts must not be empty`)
      }
    }
  }
}

function validateTolerations(config: Mapping, root: string): void {
  if (config.tolerations !== undefined) {
    if (!Array.isArray(config.tolerations)) throw new Error(`${root}.tolerations must be an array`)
    for (const value of config.tolerations) {
      const entry = mapping(value, `${root}.tolerations`, ['effect', 'key', 'operator', 'tolerationSeconds', 'value'])
      for (const field of ['effect', 'key', 'operator', 'value']) if (entry[field] !== undefined) text(entry[field], `${root}.tolerations.${field}`, true)
      if (entry.effect !== undefined && !['NoExecute', 'NoSchedule', 'PreferNoSchedule'].includes(entry.effect as string)) throw new Error(`${root}.tolerations.effect is invalid`)
      if (entry.operator !== undefined && !['Equal', 'Exists'].includes(entry.operator as string)) throw new Error(`${root}.tolerations.operator is invalid`)
      if (entry.tolerationSeconds !== undefined && (!Number.isSafeInteger(entry.tolerationSeconds) || (entry.tolerationSeconds as number) < 0)) {
        throw new Error(`${root}.tolerations.tolerationSeconds must be a non-negative integer`)
      }
    }
  }
}

function validateServiceAccount(config: Mapping, root: string): void {
  if (config.serviceAccount !== undefined) {
    const account = mapping(config.serviceAccount, `${root}.serviceAccount`, ['annotations', 'automountServiceAccountToken', 'create', 'name'])
    for (const field of ['automountServiceAccountToken', 'create']) if (account[field] !== undefined) bool(account[field], `${root}.serviceAccount.${field}`)
    if (account.name !== undefined) text(account.name, `${root}.serviceAccount.name`, true)
    if (account.annotations !== undefined) strings(account.annotations, `${root}.serviceAccount.annotations`)
  }
}

/** Validate before writing values or carrying these public inputs into doge-config. */
export function validateDstackControllerConfig(input: unknown): void {
  if (input === undefined) return
  const root = 'dstackController'
  const config = mapping(input, root, [
    'enabled', 'auth', 'credentialSecrets', 'database', 'fullnameOverride', 'image',
    'ingress', 'nodeSelector', 'persistence', 'podAnnotations', 'replicaCount',
    'resources', 'serverConfig', 'serviceAccount', 'tolerations',
  ])
  if (config.enabled !== undefined) bool(config.enabled, `${root}.enabled`)
  if (config.replicaCount !== undefined && ![0, 1].includes(config.replicaCount as number)) {
    throw new Error(`${root}.replicaCount must be 0 or 1`)
  }

  if (config.fullnameOverride !== undefined) text(config.fullnameOverride, `${root}.fullnameOverride`)
  for (const field of ['auth', 'serverConfig', 'database']) {
    if (config[field] === undefined) continue
    const ref = mapping(config[field], `${root}.${field}`, field === 'database' ? ['type', 'existingSecret', 'key'] : ['existingSecret', 'key'])
    for (const key of ['existingSecret', 'key']) if (ref[key] !== undefined) text(ref[key], `${root}.${field}.${key}`)
    if (field === 'database' && ref.type !== undefined && !['postgresql', 'sqlite'].includes(ref.type as string)) {
      throw new Error(`${root}.database.type must be postgresql or sqlite`)
    }
  }

  validateImage(config, root)

  validatePersistence(config, root)

  validateCredentialSecrets(config, root)

  for (const field of ['nodeSelector', 'podAnnotations']) if (config[field] !== undefined) strings(config[field], `${root}.${field}`)
  validateServiceAccount(config, root)

  if (config.resources !== undefined) {
    const resources = mapping(config.resources, `${root}.resources`, ['limits', 'requests'])
    for (const field of ['limits', 'requests']) if (resources[field] !== undefined) strings(resources[field], `${root}.resources.${field}`)
  }

  validateIngress(config, root)

  validateTolerations(config, root)
}

/** Complete production overrides; independent of the cluster's cloud provider. */
export function generateDstackControllerValues(config?: DstackControllerConfig): string | undefined {
  validateDstackControllerConfig(config)
  if (!config || config.enabled === false) return undefined
  const overrides = {...config}
  delete overrides.enabled
  const values = {
    ...overrides,
    auth: {existingSecret: 'dstack-controller-auth', key: 'admin-token', ...config.auth},
    credentialSecrets: config.credentialSecrets ?? [],
    database: {
      existingSecret: config.database?.type === 'sqlite' ? '' : 'dstack-controller-database',
      key: 'database-url', type: 'postgresql', ...config.database,
    },
    image: config.image ? {pullPolicy: 'IfNotPresent', tag: '', ...config.image} : {...DSTACK_CONTROLLER_IMAGE},
    ingress: {enabled: false, ...config.ingress},
    persistence: {retain: true, size: '20Gi', ...config.persistence},
    replicaCount: config.replicaCount ?? 1,
    resources: {
      limits: {memory: '4Gi', ...config.resources?.limits},
      requests: {cpu: '1', memory: '1Gi', ...config.resources?.requests},
    },
    serverConfig: {existingSecret: 'dstack-controller-config', key: 'config.yml', ...config.serverConfig},
    serviceAccount: {automountServiceAccountToken: false, create: true, ...config.serviceAccount},
  }
  return '# Generated from dstackController; edit the source configuration, then regenerate.\n'
    + '# Independent Helm release; Secret contents and GPU fleet/task submission are managed separately.\n'
    + yaml.dump(values, {lineWidth: -1, noRefs: true, sortKeys: true})
}
