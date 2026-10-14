import {Args, Flags} from '@oclif/core'

import {RotationCluster, deploymentDirectory} from './rotation-cluster.js'
import {type RotationExport, readRotationExport} from './rotation-export.js'

export const rotationArgs = {export: Args.string({description: 'dogeos/rotation-export/v1 JSON downloaded from the governance portal', required: true})}
export const rotationFlags = {
  context: Flags.string({description: 'Kubernetes context; default: the deployment spec EKS cluster, else the current context'}),
  dir: Flags.string({default: '.', description: 'Deployment directory (or its parent with runtime/ or deployment/)'}),
  namespace: Flags.string({description: 'Kubernetes namespace; default: the deployment spec namespace, else default'}),
  'wp-url': Flags.string({description: 'HTTPS or loopback WP URL; default: a temporary kubectl port-forward'}),
}
export const tsoFlag = {'tso-url': Flags.string({description: 'HTTPS or loopback TSO URL serving /metrics; default: a temporary kubectl port-forward'})}

export function rotationSetup(file: string, flags: {context?: string; dir: string; namespace?: string; 'tso-url'?: string; 'wp-url'?: string}): {cluster: RotationCluster; rotation: RotationExport} {
  const rotation = readRotationExport(file)
  const cluster = new RotationCluster({context: flags.context, deploymentDir: deploymentDirectory(flags.dir), namespace: flags.namespace, tsoUrl: flags['tso-url'], wpUrl: flags['wp-url']})
  return {cluster, rotation}
}
