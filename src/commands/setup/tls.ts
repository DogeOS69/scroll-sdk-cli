import {input} from '@inquirer/prompts'
import {Command, Flags} from '@oclif/core'
import * as yaml from 'js-yaml'
import fs from 'node:fs'
import path from 'node:path'

import {deploymentIngresses, reconcileDeploymentIngresses} from '../../utils/public-service-ingress.js'

export default class SetupTls extends Command {
  static override description = 'Configure ACM TLS on enabled AWS ALB ingresses in deployment values (no cluster changes)'
  static override examples = ['<%= config.bin %> <%= command.id %> --certificate-arn arn:aws:acm:us-east-1:123456789012:certificate/00000000-0000-0000-0000-000000000000 --non-interactive']
  static override flags = {
    'certificate-arn': Flags.string({description: 'Issued ACM certificate ARN covering the enabled ingress hosts; comma-separated ARNs are supported'}),
    json: Flags.boolean({default: false}),
    'non-interactive': Flags.boolean({char: 'N', default: false}),
    'values-dir': Flags.string({default: 'values'}),
  }

  async run(): Promise<void> {
    const {flags} = await this.parse(SetupTls)
    let certificate = flags['certificate-arn']
    if (!certificate && !flags['non-interactive']) certificate = await input({message: 'Issued ACM certificate ARN covering the enabled ingress hosts:'})
    if (!certificate) throw new Error('--certificate-arn is required; ALB terminates TLS using ACM, without cert-manager or an ingress-nginx controller')
    const writes: Array<{content: string; file: string}> = []
    for (const name of fs.readdirSync(flags['values-dir']).filter(name => /-production(?:-\d+)?\.yaml$/.test(name))) {
      const file = path.join(flags['values-dir'], name)
      const original = fs.readFileSync(file, 'utf8')
      const values = yaml.load(original) as Record<string, any>
      if (!values || typeof values !== 'object') continue
      const enabled = deploymentIngresses(values).filter(ingress => ingress.enabled !== false)
      if (enabled.length === 0) continue
      for (const ingress of enabled) {
        ingress.annotations = {...ingress.annotations, 'alb.ingress.kubernetes.io/certificate-arn': certificate}
      }

      reconcileDeploymentIngresses(values, name.replace(/-production.*$/, ''))
      const content = yaml.dump(values, {lineWidth: -1, noRefs: true})
      if (content !== original) writes.push({content, file})
    }

    // Validate all files before the first write; no partially updated certificate set.
    for (const {content, file} of writes) fs.writeFileSync(file, content)
    this.log(flags.json ? JSON.stringify({updated: writes.map(entry => entry.file)}) : `Updated ACM TLS in ${writes.length} values files. Verify certificate status, region and DNS coverage before installation.`)
  }
}
