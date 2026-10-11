/* eslint-disable @typescript-eslint/no-explicit-any -- Local plan/values and Kubernetes API documents. */
import {Args, Command, Flags} from '@oclif/core'
import * as yaml from 'js-yaml'
import fs from 'node:fs'
import path from 'node:path'
import {fileURLToPath} from 'node:url'

import {CAPACITY_MANAGER_PLAN, assertSdkWorkersRetired, prepareCapacityManager} from '../../utils/capacity-manager.js'
import {JsonOutputContext} from '../../utils/json-output.js'
import {localPath} from '../../utils/preparation-io.js'
import {capacityExec} from '../../utils/proof-workers-lifecycle.js'

export default class CapacityManager extends Command {
  static args = {action: Args.string({default: 'prepare', options: ['prepare', 'credentials', 'status']})}
  static description = 'Prepare Core capacity-manager configuration and credentials; install separately with Helm to start renting workers'
  static flags = {'deployment-dir': Flags.string({default: '.'}), json: Flags.boolean({default: false}), 'kube-context': Flags.string({description: 'Explicit Kubernetes context; otherwise uses the current context'})}

  async run(): Promise<void> {
    const {args, flags} = await this.parse(CapacityManager)
    const out = new JsonOutputContext('setup capacity-manager', flags.json)
    try {
      const root = path.resolve(flags['deployment-dir'])
      if (args.action === 'prepare') {
        const result = prepareCapacityManager(root)
        out.info('No GPU allocation. Install WP with the generated network policy, prepare credentials, then explicitly run make install-capacity-manager.')
        out.success(result)
        return
      }

      const plan = JSON.parse(fs.readFileSync(localPath(root, CAPACITY_MANAGER_PLAN), 'utf8'))
      if (plan.schema !== 'scrollsdk/capacity-manager/v1') throw new Error('Unsupported capacity-manager plan')
      const context = flags['kube-context'] ? ['--context', flags['kube-context']] : []
      const run = (namespace: string, args: string[], input?: string) => capacityExec([...context, '--namespace', namespace, ...args], input)
      if (args.action === 'status') {
        const result = run(plan.namespace, ['get', 'deployment', 'capacity-manager', '--ignore-not-found', '-o', 'json'])
        const deployment = result.trim() ? JSON.parse(result) : undefined
        out.success({present: Boolean(deployment), readyReplicas: deployment?.status?.readyReplicas ?? 0, replicas: deployment?.spec?.replicas ?? 0})
        return
      }

      assertSdkWorkersRetired(root)
      const values = yaml.load(fs.readFileSync(localPath(root, plan.valuesFile), 'utf8')) as any
      if (values.manager.dstack.project !== plan.project || values.manager.workerTokenSecret !== plan.workerTokenSecret) throw new Error('Regenerate the capacity-manager plan after changing its credential bindings')
      const readSecret = (namespace: string, name: string, key: string) => {
        const secret = JSON.parse(run(namespace, ['get', 'secret', name, '-o', 'json']))
        if (!secret.data?.[key]) throw new Error('Required credential Secret/key is missing')
        return Buffer.from(secret.data[key], 'base64').toString('utf8').trim()
      }

      const workerToken = readSecret(plan.namespace, plan.proofSecret, 'prover-worker-token')
      const dstackToken = readSecret(plan.dstack.namespace, plan.dstack.auth.existingSecret, plan.dstack.auth.key)
      const existing = run(plan.namespace, ['get', 'secret', 'capacity-manager-dstack-auth', '--ignore-not-found', '-o', 'json'])
      if (existing.trim() && JSON.parse(existing).metadata?.labels?.['app.kubernetes.io/managed-by'] !== 'scrollsdk-capacity-manager') throw new Error('Refusing to overwrite an independently managed capacity-manager-dstack-auth Secret')
      const adapter = fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../config/capacity-manager-credentials.py'), 'utf8')
      run(plan.dstack.namespace, ['exec', '-i', `deployment/${plan.dstack.deployment}`, '-c', 'controller', '--', '/root/.local/share/uv/tools/dstack/bin/python', '-c', adapter], JSON.stringify({fleets: values.manager.dstack.fleets, project: plan.project, secretName: plan.workerTokenSecret, token: workerToken}))
      run(plan.namespace, ['apply', '-f', '-'], JSON.stringify({apiVersion: 'v1', kind: 'Secret', metadata: {labels: {'app.kubernetes.io/managed-by': 'scrollsdk-capacity-manager'}, name: 'capacity-manager-dstack-auth', namespace: plan.namespace}, stringData: {'token': dstackToken}, type: 'Opaque'}))
      out.info('Prepared credential references only. No workers started; explicitly install the capacity-manager release after reviewing the generated policy.')
      out.success({namespace: plan.namespace, project: plan.project, updated: true})
    } catch (error) {out.error('E761_CAPACITY_MANAGER_FAILED', error instanceof Error ? error.message : 'Capacity manager preparation failed', 'CONFIGURATION', true)}
  }
}
