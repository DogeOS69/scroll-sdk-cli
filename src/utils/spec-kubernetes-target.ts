import type {DeploymentSpec} from '../types/deployment-spec.js'

/** One target for generated Helm commands and preparation Secret uploads. */
export function specKubernetesTarget(spec: DeploymentSpec): {kubeContext?: string; namespace: string} {
  const infra = spec.infrastructure
  const upload = spec.preparation?.secretUpload
  if (infra.kubeContext && upload?.kubeContext && infra.kubeContext !== upload.kubeContext) {
    throw new Error('infrastructure.kubeContext and preparation.secretUpload.kubeContext must match')
  }

  if (upload?.namespace && (infra.namespace ?? 'default') !== upload.namespace) {
    throw new Error('infrastructure.namespace and preparation.secretUpload.namespace must match')
  }

  const kubeContext = infra.kubeContext ?? upload?.kubeContext
  const namespace = infra.namespace ?? 'default'
  // These values become Makefile defaults and double-quoted shell arguments.
  if (kubeContext !== undefined && !/^[\w+./:@-]+$/.test(kubeContext)) {
    throw new Error('Kubernetes context must be nonempty and contain only letters, digits, _, ., :, /, @, + or -')
  }

  if (!/^[\da-z](?:[\da-z-]{0,61}[\da-z])?$/.test(namespace)) {
    throw new Error('Kubernetes namespace must be a DNS label of at most 63 characters')
  }

  return {kubeContext, namespace}
}

export function bindMakefileTarget(source: string, spec: DeploymentSpec): string {
  const {kubeContext, namespace} = specKubernetesTarget(spec)
  for (const [name, value] of [['KUBE_CONTEXT', kubeContext ?? ''], ['NAMESPACE', namespace]]) {
    const declaration = new RegExp(`^${name}\\s*\\?=.*$`, 'm')
    const line = `${name} ?= ${value}`
    source = declaration.test(source) ? source.replace(declaration, line) : `${line}\n${source}`
  }

  return source
}
