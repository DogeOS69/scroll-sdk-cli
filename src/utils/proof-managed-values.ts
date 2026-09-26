import * as toml from '@iarna/toml'
import * as yaml from 'js-yaml'
import {createHash} from 'node:crypto'
import fs from 'node:fs'

type Mapping = Record<string, unknown>
const object = (value: unknown): Mapping => value && typeof value === 'object' && !Array.isArray(value) ? value as Mapping : {}
const owned = (key: string): boolean => /proof|prover|materializ|protocol.context|segmentation|cubesigner.*production.policy|chunk.*commit|batch.*commit|bridge.*commit|aggregation|openvm|artifact.store/i.test(key)
const ownedEnv = (key: string): boolean => owned(key) || /^(NETWORK|DOGEOS_CUBESIGNER_SIGNER_(CS_KEY_ID|CS_SESSION_PATH|NETWORK))$/.test(key) || key.startsWith('DOGEOS_ETH_DA_SUBMITTER_S3__') || key.startsWith('AWS_')

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(item => canonical(item))
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]))
  return value
}

// Field ownership is semantic: chart resources, replicas, ingress and unrelated
// logging/ingress overlays do not change the compiler's proof contract.
export function proofManagedValuesDigest(file: string, component: string): string {
  const parsed = yaml.load(fs.readFileSync(file, 'utf8'))
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`values must be a YAML mapping: ${file}`)
  const values = parsed as Mapping
  const fullRuntime = ['eagerMaterializer', 'proofCoordinator', 'proverWorker'].includes(component)
  const env = Array.isArray(values.env)
    ? values.env.filter(item => ownedEnv(String(object(item).name))).sort((a, b) => String(object(a).name).localeCompare(String(object(b).name)))
    : Object.fromEntries(Object.entries(object(values.env)).filter(([key]) => ownedEnv(key)))
  const configMaps: Mapping = {}
  for (const [name, item] of Object.entries(object(values.configMaps))) {
    if (owned(name)) configMaps[name] = item
    else {
      const data: Mapping = {}
      for (const [key, content] of Object.entries(object(object(item).data))) {
        if (key.endsWith('.toml') && typeof content === 'string') {
          const document = toml.parse(content)
          data[key] = Object.fromEntries(Object.entries(document).filter(([section]) => fullRuntime ? !['log_level', 'logging', 'metrics'].includes(section) : owned(section)))
        } else if (ownedEnv(key) || (fullRuntime && name !== 'env')) data[key] = content
      }

      if (Object.keys(data).length > 0) configMaps[name] = {data, enabled: object(item).enabled}
    }
  }

  const select = (value: unknown): Mapping => Object.fromEntries(Object.entries(object(value)).filter(([key]) => owned(key)))
  const result = {
    configMaps, env,
    ...(fullRuntime ? {args: values.args, command: values.command, image: values.image} : {}),
    ...(component === 'cubesignerSigner' || fullRuntime ? {externalSecrets: values.externalSecrets} : {externalSecrets: select(values.externalSecrets)}),
    ...(component === 'cubesignerSigner' ? {image: values.image} : {}),
    ...(['proofCoordinator', 'withdrawalProcessor'].includes(component) ? {serviceAccount: values.serviceAccount} : {}),
    initContainers: select(values.initContainers),
    persistence: select(values.persistence),
    podAnnotations: select(values.podAnnotations),
    service: Object.fromEntries(Object.entries(object(values.service)).map(([name, service]) => [name, {ports: select(object(service).ports)}])),
  }
  return createHash('sha256').update(JSON.stringify(canonical(result))).digest('hex')
}
