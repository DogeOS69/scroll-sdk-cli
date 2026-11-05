/* eslint-disable @typescript-eslint/no-explicit-any -- Helm values are dynamic YAML mappings. */
import * as yaml from 'js-yaml'

interface SecretReferenceTarget {
  awsRegion?: string
  prefix: string
  provider: string
}

/** The SDK templates ship these regions and `scroll/<name>`, `dogeos/<name>` or bare `<name>` keys. */
const TEMPLATE_REGIONS = new Set([undefined, '<TODO>', 'us-west-2'])
const TEMPLATE_KEY = /^(?:(?:dogeos|scroll)\/)?[^/]+$/

/**
 * Point SDK template ExternalSecrets at this deployment's Secrets Manager path.
 * Keys and regions the operator already selected are kept; only template
 * defaults are rewritten, so applying this again changes nothing.
 */
export function reconcileExternalSecretReferences(values: any, secrets: SecretReferenceTarget): boolean {
  if (secrets.provider !== 'aws' || !values?.externalSecrets || typeof values.externalSecrets !== 'object') return false
  let changed = false
  for (const secret of Object.values<any>(values.externalSecrets)) {
    if (secret?.provider !== 'aws') continue
    if (secrets.awsRegion && secret.secretRegion !== secrets.awsRegion && TEMPLATE_REGIONS.has(secret.secretRegion)) {
      secret.secretRegion = secrets.awsRegion
      changed = true
    }

    for (const item of Array.isArray(secret.data) ? secret.data : []) {
      const key = item?.remoteRef?.key
      if (typeof key !== 'string' || !TEMPLATE_KEY.test(key)) continue
      const target = `${secrets.prefix}/${key.split('/').at(-1)}`
      if (key === target) continue
      item.remoteRef.key = target
      changed = true
    }
  }

  return changed
}

/** Apply the reconciliation to rendered values files, leaving unrelated formatting untouched. */
export function reconcileExternalSecretFiles(files: Record<string, string>, secrets: SecretReferenceTarget): void {
  for (const [name, content] of Object.entries(files)) {
    if (!name.endsWith('.yaml') || !content.includes('externalSecrets')) continue
    const values = yaml.load(content)
    if (reconcileExternalSecretReferences(values, secrets)) files[name] = yaml.dump(values, {lineWidth: -1, noRefs: true})
  }
}
