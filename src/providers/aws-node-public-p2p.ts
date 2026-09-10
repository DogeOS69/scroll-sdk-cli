/* eslint-disable @typescript-eslint/no-explicit-any -- Dynamic Helm values. */
import {input} from '@inquirer/prompts'
import * as yaml from 'js-yaml'
import {execFile} from 'node:child_process'
import {createHash} from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {promisify} from 'node:util'

import {YAML_DUMP_OPTIONS} from '../config/constants.js'

const execFileAsync = promisify(execFile)
const CONTROLLER = 'aws-load-balancer-controller'
const ANNOTATION = 'service.beta.kubernetes.io/aws-load-balancer-'

export interface NodeLBProvider {
  checkPrerequisites(flags?: any): Promise<boolean>
  setupLb(flags: any, bootnodeIndices: number[]): Promise<string[]>
}

export class AWSNodeLBProvider implements NodeLBProvider {
  constructor(private readonly log: (message: string) => void = console.log) {}

  async checkPrerequisites(flags: any = {}): Promise<boolean> {
    const commands: [string, string[]][] = [
      ['aws', ['--version']], ['kubectl', ['version', '--client']],
      ...(flags['skip-controller-setup'] ? [] : [
        ['eksctl', ['version']], ['helm', ['version']], ['curl', ['--version']],
      ] as [string, string[]][]),
    ]
    for (const [binary, args] of commands) await this.run(binary, args)
    await this.run('aws', ['sts', 'get-caller-identity'])
    return true
  }

  async setupLb(flags: any, bootnodeIndices: number[]): Promise<string[]> {
    const cluster = await this.required(flags['cluster-name'], '--cluster-name', 'EKS cluster name:', flags['non-interactive'])
    const region = await this.required(flags.region, '--region', 'AWS region:', flags['non-interactive'])
    if (!/^[\dA-Za-z][\w-]{0,99}$/.test(cluster)) throw new Error('Invalid EKS cluster name')
    if (!/^[a-z]{2}(?:-[a-z]+)+-\d+$/.test(region)) throw new Error('Invalid AWS region')
    const namespace = flags.namespace || 'default'
    if (!/^[\da-z](?:[\da-z-]{0,61}[\da-z])?$/.test(namespace)) throw new Error('Invalid Kubernetes namespace')

    // Parse and validate every file before provisioning or changing any values.
    const prepared = this.prepareProductionFiles(flags['values-dir'], bootnodeIndices, cluster)
    await this.checkPrerequisites(flags)
    const clusterInfo = JSON.parse(await this.run('aws', ['eks', 'describe-cluster', '--name', cluster, '--region', region]))
    if (!clusterInfo.cluster?.endpoint || !clusterInfo.cluster?.resourcesVpcConfig?.vpcId) throw new Error('EKS cluster endpoint or VPC is missing')
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'scrollsdk-p2p-'))
    const kubeconfig = path.join(workspace, 'kubeconfig')
    try {
      // Never use or replace the operator's current kubeconfig/context.
      const source = await this.run('aws', ['eks', 'update-kubeconfig', '--name', cluster, '--region', region, '--kubeconfig', kubeconfig, '--dry-run'])
      const config = yaml.load(source) as any
      const context = config?.contexts?.find((item: any) => item.name === config['current-context'])
      const target = config?.clusters?.find((item: any) => item.name === context?.context?.cluster)
      if (target?.cluster?.server !== clusterInfo.cluster.endpoint) throw new Error('Generated kubeconfig does not select the requested EKS cluster')
      fs.writeFileSync(kubeconfig, source, {mode: 0o600})

      if (!flags['skip-controller-setup']) {
        await this.installController(cluster, region, clusterInfo.cluster.resourcesVpcConfig.vpcId, kubeconfig, workspace, flags['controller-chart-version'])
      }

      await this.run('kubectl', ['--kubeconfig', kubeconfig, 'wait', '--for=condition=available', '--timeout=180s', `deployment/${CONTROLLER}`, '-n', 'kube-system'], 190_000)
      const available = await this.run('kubectl', ['--kubeconfig', kubeconfig, 'get', 'deployment', CONTROLLER, '-n', 'kube-system', '-o', 'jsonpath={.status.conditions[?(@.type=="Available")].status}'])
      if (available !== 'True') throw new Error('AWS Load Balancer Controller is not available in the requested cluster')

      this.writePreparedFiles(prepared)
      for (const index of bootnodeIndices) {
        this.log(`Apply the reviewed bootnode ${index} Helm values in namespace ${namespace}; then inspect Service l2-reth-bootnode-${index}-p2p for its public endpoint.`)
      }

      this.log('Public P2P values prepared. Bootnode Services and NLBs are created by the subsequent Helm rollout; public connectivity has not been checked.')
      return prepared.map(item => item.file)
    } finally {
      fs.rmSync(workspace, {force: true, recursive: true})
    }
  }

  private configL2BootnodeP2p(doc: any, index: number, clusterName: string): void {
    doc.reth ||= {}
    doc.reth.service ||= {}
    doc.reth.service.extra ||= {}
    doc.reth.service.extra.p2p ||= {}
    const {p2p} = doc.reth.service.extra
    const port = Number(doc.reth.ports?.p2p ?? 30_303)
    if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error(`Bootnode ${index} P2P port must be an integer between 1 and 65535`)
    p2p.annotations ||= {}
    const {annotations} = p2p
    // Existing Service ownership/scheme must be migrated explicitly, not silently changed.
    if (annotations[`${ANNOTATION}type`] && !['external', 'nlb-ip'].includes(annotations[`${ANNOTATION}type`])) {
      throw new Error(`Bootnode ${index} has legacy load balancer ownership; review and recreate its Service before changing ${ANNOTATION}type to external`)
    }

    if ((annotations[`${ANNOTATION}scheme`] && annotations[`${ANNOTATION}scheme`] !== 'internet-facing') || annotations[`${ANNOTATION}internal`] === 'true') {
      throw new Error(`Bootnode ${index} has an internal load balancer; review its Service before enabling public P2P`)
    }

    p2p.enabled = true
    p2p.type = 'LoadBalancer'
    p2p.ports = {
      'p2p-tcp': {enabled: true, port, protocol: 'TCP', targetPort: port},
      'p2p-udp': {enabled: true, port, protocol: 'UDP', targetPort: port},
    }
    annotations[`${ANNOTATION}type`] ||= 'external'
    annotations[`${ANNOTATION}scheme`] = 'internet-facing'
    annotations[`${ANNOTATION}nlb-target-type`] ||= 'ip'
    annotations[`${ANNOTATION}enable-tcp-udp-listener`] = 'true'
    annotations[`${ANNOTATION}cross-zone-load-balancing-enabled`] = 'true'
    const fullName = `${clusterName}-b-${index}`.replaceAll('_', '-')
    const shortName = fullName.length <= 32 ? fullName : `${fullName.slice(0, 23)}-${createHash('sha256').update(fullName).digest('hex').slice(0, 8)}`
    annotations[`${ANNOTATION}name`] ||= shortName
    if (String(annotations[`${ANNOTATION}name`]).length > 32) throw new Error(`Bootnode ${index} load balancer name exceeds 32 characters`)
  }

  private async installController(cluster: string, region: string, vpc: string, kubeconfig: string, workspace: string, version?: string): Promise<void> {
    await this.run('helm', ['repo', 'add', 'eks', 'https://aws.github.io/eks-charts'])
    await this.run('helm', ['repo', 'update', 'eks'])
    const chart = yaml.load(await this.run('helm', ['show', 'chart', `eks/${CONTROLLER}`, ...(version ? ['--version', version] : [])])) as any
    if (!/^\d+\.\d+\.\d+(?:[+-][\w.-]+)?$/.test(String(chart?.version)) || !/^v?\d+\.\d+\.\d+(?:[+-][\w.-]+)?$/.test(String(chart?.appVersion))) {
      throw new Error('Controller chart metadata must contain a release version and appVersion')
    }

    const appVersion = String(chart.appVersion).replace(/^v/, '')
    const policyFile = path.join(workspace, 'iam-policy.json')
    await this.run('curl', ['-fsSL', '-o', policyFile, `https://raw.githubusercontent.com/kubernetes-sigs/aws-load-balancer-controller/v${appVersion}/docs/install/iam_policy.json`])
    const policy = JSON.parse(fs.readFileSync(policyFile, 'utf8'))
    if (!Array.isArray(policy.Statement) || policy.Statement.length === 0) throw new Error('Controller IAM policy is empty or invalid')
    const identity = JSON.parse(await this.run('aws', ['sts', 'get-caller-identity']))
    const partition = String(identity.Arn).split(':')[1]
    if (!/^\d{12}$/.test(identity.Account) || !/^aws(?:-[a-z]+)*$/.test(partition)) throw new Error('Invalid AWS caller identity')
    // Versioned policy avoids silently reusing stale permissions from an older controller.
    const policyName = `AWSLoadBalancerControllerIAMPolicy-${appVersion}`
    const policyArn = `arn:${partition}:iam::${identity.Account}:policy/${policyName}`
    await this.run('eksctl', ['utils', 'associate-iam-oidc-provider', '--region', region, '--cluster', cluster, '--approve'])
    try {
      await this.run('aws', ['iam', 'create-policy', '--policy-name', policyName, '--policy-document', `file://${policyFile}`])
    } catch (error) {
      if (!String(error).includes('EntityAlreadyExists')) throw error
      await this.run('aws', ['iam', 'get-policy', '--policy-arn', policyArn])
    }

    await this.run('eksctl', ['create', 'iamserviceaccount', '--cluster', cluster, '--namespace', 'kube-system', '--name', CONTROLLER, '--attach-policy-arn', policyArn, '--override-existing-serviceaccounts', '--approve', '--region', region], 600_000)
    await this.run('helm', ['--kubeconfig', kubeconfig, 'upgrade', '-i', CONTROLLER, `eks/${CONTROLLER}`, '--version', String(chart.version), '-n', 'kube-system', '--set-string', `clusterName=${cluster}`, '--set', 'serviceAccount.create=false', '--set-string', `serviceAccount.name=${CONTROLLER}`, '--set-string', `region=${region}`, '--set-string', `vpcId=${vpc}`])
  }

  private prepareProductionFiles(valuesDir: string, indices: number[], cluster: string): {content: string; file: string; original: string}[] {
    return indices.map(index => {
      const file = path.join(valuesDir, `l2-reth-bootnode-production-${index}.yaml`)
      if (!fs.existsSync(file)) throw new Error(`Missing ${file}; run setup prep-charts first`)
      const original = fs.readFileSync(file, 'utf8')
      const doc = yaml.load(original) as any
      if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new Error(`Invalid values mapping: ${file}`)
      this.configL2BootnodeP2p(doc, index, cluster)
      return {content: yaml.dump(doc, YAML_DUMP_OPTIONS), file, original}
    })
  }

  private async required(value: string | undefined, flag: string, message: string, nonInteractive: boolean): Promise<string> {
    if (value?.trim()) return value.trim()
    if (nonInteractive) throw new Error(`${flag} is required in non-interactive mode`)
    const result = (await input({message, required: true})).trim()
    if (!result) throw new Error(`${flag} must not be empty`)
    return result
  }

  private async run(binary: string, args: string[], timeout = 180_000): Promise<string> {
    this.log(`Running ${binary} ${args.join(' ')}`)
    try {
      const result = await execFileAsync(binary, args, {maxBuffer: 4 * 1024 * 1024, timeout})
      return result.stdout.trim()
    } catch (error) {
      const failure = error as {stderr?: string} & Error
      throw new Error(`${binary} failed: ${failure.stderr?.trim() || failure.message}`)
    }
  }

  private async updateProductionFiles(valuesDir: string, indices: number[], _region: string, cluster: string): Promise<void> {
    this.writePreparedFiles(this.prepareProductionFiles(valuesDir, indices, cluster))
  }

  private writePreparedFiles(prepared: {content: string; file: string; original: string}[]): void {
    const written: typeof prepared = []
    try {
      for (const item of prepared) {
        fs.writeFileSync(item.file, item.content)
        written.push(item)
      }
    } catch (error) {
      for (const item of written) fs.writeFileSync(item.file, item.original)
      throw error
    }
  }
}
