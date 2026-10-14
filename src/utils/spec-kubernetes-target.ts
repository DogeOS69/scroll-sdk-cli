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

  if (spec.capacityManager) {
    const recipe = '\tscrollsdk setup capacity-manager credentials --dir . --kube-context "$(KUBE_CONTEXT)" --namespace "$(NAMESPACE)"\n'
    if (!/^install-capacity-manager:/m.test(source)) throw new Error('SDK Makefile lacks install-capacity-manager; use the matching capacity-manager SDK checkout')
    // The operator invokes Make only. This API synchronization happens after
    // dstack startup, before Helm can start a manager and rent workers.
    source = source.replace(/^(install-capacity-manager:[^\n]*\n)(?:\tscrollsdk setup capacity-manager credentials[^\n]*\n)?/m, `$1${recipe}`)
  }

  // Older SDK templates used a separate namespace. Normal spec deployments do not.
  return source.replaceAll(/^DSTACK_NAMESPACE\s*\?=.*\n/gm, '').replaceAll('$(DSTACK_NAMESPACE)', '$(NAMESPACE)')
}

/** Spec deployments have one namespace, including controller monitoring and credentials. */
export function specDstackController(spec: DeploymentSpec): DstackControllerConfig | undefined {
  const config = spec.dstackController
  if (!config || config.enabled === false) return config
  const {namespace} = specKubernetesTarget(spec)
  if (config.monitoring?.namespace && config.monitoring.namespace !== namespace) {
    throw new Error('dstackController.monitoring.namespace must match infrastructure.namespace; spec deployments use one namespace')
  }

  return {...config, monitoring: {...config.monitoring, namespace}}
}
