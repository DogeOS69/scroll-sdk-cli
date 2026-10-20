import {Command, Flags} from '@oclif/core'
import fs from 'node:fs'
import path from 'node:path'
import toml from 'toml'

import {AwsCliRunner} from '../../utils/aws-cli.js'
import {readAlbValues, readExistingAlbSpec} from '../../utils/existing-alb.js'
import {publicBootnodeEnodes, verifyExistingNlb, verifyExistingNlbTargets} from '../../utils/existing-nlb.js'
import {specKubernetesTarget} from '../../utils/spec-kubernetes-target.js'

export default class Nlb extends Command {
  static description = 'Verify independently managed bootnode NLBs, source restrictions and bindings without changing AWS resources'
  static flags = {
    'aws-profile': Flags.string(),
    dir: Flags.string({default: '.', description: 'Deployment directory'}),
    json: Flags.boolean({default: false}),
    'kube-context': Flags.string({description: 'Must match the spec Kubernetes target'}),
    namespace: Flags.string({description: 'Must match the spec namespace'}),
    'require-targets': Flags.boolean({default: false, description: 'After install, require exact live binding, dedicated pod, AZ and healthy target'}),
    spec: Flags.string({description: 'Defaults to saved preparation intent or deployment-spec.yaml'}),
    'values-dir': Flags.string({default: 'values'}),
  }

  async run(): Promise<void> {
    const {flags} = await this.parse(Nlb)
    const root = path.resolve(flags.dir)
    const spec = readExistingAlbSpec(root, flags.spec)
    if (!spec) throw new Error('An explicit deployment spec or saved preparation intent is required')
    const target = specKubernetesTarget(spec)
    if (flags.namespace && flags.namespace !== target.namespace || flags['kube-context'] && flags['kube-context'] !== target.kubeContext) throw new Error('Namespace/context must match the deployment spec')
    const aws = new AwsCliRunner(flags['aws-profile'])
    const verified = verifyExistingNlb(spec, readAlbValues(path.resolve(root, flags['values-dir'])), aws)
    const healthy = flags['require-targets'] ? verifyExistingNlbTargets(spec, verified, aws) : undefined
    const identityFile = path.join(root, '.data/doge-config.toml')
    let identities: Array<{enodeUrl?: string; index: number}> = []
    if (fs.existsSync(identityFile)) {
      try {identities = toml.parse(fs.readFileSync(identityFile, 'utf8')).bootnodeReth?.instances ?? []} catch {throw new Error('Cannot parse saved bootnode identity configuration (private file contents omitted)')}
    }

    const endpoints = verified.map(item => {
      const identity = identities.find(identity => identity.index === item.entry.index)?.enodeUrl
      return {enodes: identity ? publicBootnodeEnodes(identity, item.publicEndpoints) : undefined, index: item.entry.index, publicEndpoints: item.publicEndpoints, service: item.serviceName}
    })
    const note = 'No AWS resources changed. Partner allowlists are owned by AWS infrastructure; this check validates network boundaries, not partner approval. Empty ingress is closed. Partner RLPx identity, allow/deny-source and block-sync tests are still required; a healthy TCP target is not protocol acceptance.'
    this.log(flags.json ? JSON.stringify({endpoints, healthy, note, verified: true}) : `Verified ${verified.length} independent bootnode NLBs.\n${endpoints.map(item => `bootnode ${item.index}: ${item.enodes?.join(', ') ?? `${item.publicEndpoints.join(', ')} (saved public identity unavailable; retain the existing enode public key)`}`).join('\n')}\n${note}`)
  }
}
