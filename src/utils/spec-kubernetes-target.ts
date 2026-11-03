import type {DeploymentSpec} from '../types/deployment-spec.js'
import type {DstackControllerConfig} from '../types/dstack-controller.js'

/** One target for generated Helm commands and preparation Secret uploads. */
export function specKubernetesTarget(spec: DeploymentSpec): {kubeContext?: string; namespace: string} {
  const infra = spec.infrastructure ?? {}
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

  // Remove only the retired generated callback; initialization now belongs to Helm.
  if (spec.capacityManager) source = source.replaceAll(/^\tscrollsdk setup capacity-manager credentials[^\n]*\n/gm, '')

  // Older SDK templates used a separate namespace. Normal spec deployments do not.
  return source.replaceAll(/^DSTACK_NAMESPACE\s*\?=.*\n/gm, '').replaceAll('$(DSTACK_NAMESPACE)', '$(NAMESPACE)')
}

/** Spec deployments have one namespace, including controller monitoring and credentials. */
export function specDstackController(spec: DeploymentSpec): DstackControllerConfig | undefined {
  const config = spec.dstackController
  if (!config || config.enabled === false) return config
  const {namespace} = specKubernetesTarget(spec)
  if (config.internalTls && config.internalTls.certificateArn.split(':')[3] !== spec.infrastructure.aws?.region) throw new Error('dstack internalTls certificate and infrastructure AWS region must match')
  if (config.monitoring?.namespace && config.monitoring.namespace !== namespace) {
    throw new Error('dstackController.monitoring.namespace must match infrastructure.namespace; spec deployments use one namespace')
  }

  return {...config, monitoring: {...config.monitoring, namespace}}
}
