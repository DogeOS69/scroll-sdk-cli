import {Command, Flags} from '@oclif/core'
import {execFileSync} from 'node:child_process'
import path from 'node:path'

import {AwsCliRunner} from '../../utils/aws-cli.js'
import {readAlbValues, readExistingAlbSpec, verifyExistingAlb} from '../../utils/existing-alb.js'
import {specKubernetesTarget} from '../../utils/spec-kubernetes-target.js'

export default class Alb extends Command {
  static description = 'Verify existing ALB listeners, routes and target groups without changing AWS resources'
  static flags = {
    'aws-profile': Flags.string(),
    dir: Flags.string({default: '.', description: 'Deployment directory'}),
    json: Flags.boolean({default: false}),
    'kube-context': Flags.string({description: 'Must match the spec Kubernetes target'}),
    namespace: Flags.string({description: 'Must match the spec namespace'}),
    'require-services': Flags.boolean({default: false, description: 'Verify installed Services and TargetGroupBinding CRD before installing bindings'}),
    spec: Flags.string({description: 'Spec path; defaults to frozen intent or deployment-spec.yaml'}),
    'values-dir': Flags.string({default: 'values'}),
  }

  async run(): Promise<void> {
    const {flags} = await this.parse(Alb)
    const root = path.resolve(flags.dir)
    const spec = readExistingAlbSpec(root, flags.spec)
    if (!spec) throw new Error('An explicit deployment spec or saved preparation intent is required')
    const result = verifyExistingAlb(spec, readAlbValues(path.resolve(root, flags['values-dir'])), new AwsCliRunner(flags['aws-profile']))
    const target = specKubernetesTarget(spec)
    if (flags.namespace && flags.namespace !== target.namespace || flags['kube-context'] && flags['kube-context'] !== target.kubeContext) throw new Error('Helm namespace/context must match the deployment spec')
    if (flags['require-services']) {
      if (!target.kubeContext) throw new Error('infrastructure.kubeContext is required for Service verification')
      const kube = (args: string[]): string => {
        try {return execFileSync('kubectl', ['--context', target.kubeContext!, ...args], {encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000})} catch {throw new Error('Existing ALB Kubernetes verification failed; check context, CRD and Services (provider output omitted)')}
      }

      let clusterEndpoint: string
      try {clusterEndpoint = new AwsCliRunner(flags['aws-profile']).json(['eks', 'describe-cluster', '--name', spec.infrastructure.aws!.eksClusterName], {region: spec.infrastructure.aws!.region}).cluster.endpoint} catch {throw new Error('Cannot verify EKS context (provider output omitted)')}
      if (kube(['config', 'view', '--minify', '-o', 'jsonpath={.clusters[0].cluster.server}']).trim() !== clusterEndpoint) throw new Error('Kubernetes context does not address the selected EKS cluster')
      kube(['get', 'crd', 'targetgroupbindings.elbv2.k8s.aws', '-o', 'name'])
      for (const [name, binding] of Object.entries(spec.infrastructure.aws!.alb!.bindings)) {
        const service = JSON.parse(kube(['get', 'service', binding.serviceRef.name, '-n', target.namespace, '-o', 'json']))
        if (service.spec?.type !== 'ClusterIP' || Object.keys(service.spec?.selector ?? {}).length === 0 || !service.spec.ports?.some((port: {port: number; protocol: string}) => port.port === binding.serviceRef.port && port.protocol === 'TCP')) throw new Error(`${name}: serviceRef must select a ClusterIP Service with pod selectors and the configured TCP port`)
      }
    }

    this.log(flags.json ? JSON.stringify({...result, verified: true}) : `Verified ${result.bindings.length} bindings on ${result.loadBalancers} existing ALBs. No AWS resources changed.`)
  }
}
