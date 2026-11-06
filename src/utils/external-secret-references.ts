/* eslint-disable @typescript-eslint/no-explicit-any -- Helm values are dynamic YAML mappings. */
import * as yaml from 'js-yaml'

interface SecretReferenceTarget {
  awsRegion?: string
  prefix: string
  provider: string
}

const UNSET_REGIONS = new Set([undefined, '<TODO>'])

/**
 * Point SDK template ExternalSecrets at this deployment's Secrets Manager path.
 * Only values still equal to the file's SDK template are defaults. Anything else
 * was selected for this deployment and is kept, so applying this again changes
 * nothing. An operator who wants a template value kept pins it through helmValues.
 */
export function reconcileExternalSecretReferences(values: any, secrets: SecretReferenceTarget, template: any): boolean {
  if (secrets.provider !== 'aws' || !values?.externalSecrets || typeof values.externalSecrets !== 'object') return false
  let changed = false
  for (const [name, secret] of Object.entries<any>(values.externalSecrets)) {
    const templateSecret = template?.externalSecrets?.[name]
    if (secret?.provider !== 'aws' || !templateSecret) continue
    const templateRegion = UNSET_REGIONS.has(secret.secretRegion) || secret.secretRegion === templateSecret.secretRegion
    if (secrets.awsRegion && secret.secretRegion !== secrets.awsRegion && templateRegion) {
      secret.secretRegion = secrets.awsRegion
      changed = true
    }

    const templateData = Array.isArray(templateSecret.data) ? templateSecret.data : []
    for (const item of Array.isArray(secret.data) ? secret.data : []) {
      const key = item?.remoteRef?.key
      const templateKey = templateData.find((entry: any) => entry?.secretKey === item?.secretKey)?.remoteRef?.key
      if (typeof key !== 'string' || key !== templateKey) continue
      const target = `${secrets.prefix}/${key.split('/').at(-1)}`
      if (key === target) continue
      item.remoteRef.key = target
      changed = true
    }
  }

  return changed
}

/** Apply the reconciliation to rendered values files, leaving unrelated formatting untouched. */
export function reconcileExternalSecretFiles(files: Record<string, string>, secrets: SecretReferenceTarget, templateFiles: Record<string, string>): void {
  for (const [name, content] of Object.entries(files)) {
    const templateContent = templateFiles[`values/${name}`]
    if (!name.endsWith('.yaml') || !content.includes('externalSecrets') || !templateContent) continue
    const values = yaml.load(content)
    if (reconcileExternalSecretReferences(values, secrets, yaml.load(templateContent))) files[name] = yaml.dump(values, {lineWidth: -1, noRefs: true})
  }
}
