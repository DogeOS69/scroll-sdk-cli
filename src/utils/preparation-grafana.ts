import * as toml from '@iarna/toml'
import * as yaml from 'js-yaml'
import fs from 'node:fs'
import path from 'node:path'
import {isDeepStrictEqual} from 'node:util'

import type {DogeConfig} from '../types/doge-config.js'

import {configureGrafanaAdmin, grafanaAdminReference, writeGrafanaPrivateFile} from './grafana-admin.js'
import {reconcileScrollMonitorGrafana} from './scroll-monitor-values.js'

/** Prepare the admin identity before charts bind the deployment config hash. */
export async function prepareGrafanaAdmin(root: string): Promise<void> {
  root = fs.realpathSync(root)
  const valuesFile = path.join(root, 'values/scroll-monitor-production.yaml')
  if (!fs.existsSync(valuesFile)) return
  const values = yaml.load(fs.readFileSync(valuesFile, 'utf8')) as {grafana?: {admin?: {existingSecret?: string; passwordKey?: string; userKey?: string}; enabled?: boolean}}
  if (!values?.grafana || values.grafana.enabled === false) return
  const file = path.join(root, '.data/doge-config.toml')
  const config = toml.parse(fs.readFileSync(file, 'utf8')) as unknown as DogeConfig
  const reference = values.grafana.admin ?? {}
  const existing = config.grafana
  const resolved = grafanaAdminReference({...reference, ...existing})
  // Never silently rotate a credential whose local identity state was lost.
  if (!existing?.adminPassword && ['env', 'yaml'].some(extension => fs.existsSync(path.join(root, 'secrets', `${resolved.existingSecret}.${extension}`)))) {
    throw new Error('Grafana Secret already exists without its admin identity; restore grafana credentials in .data/doge-config.toml before resuming')
  }

  config.grafana = await configureGrafanaAdmin({...resolved, ...existing}, true)
  if (!isDeepStrictEqual({...config.grafana}, {...existing})) writeGrafanaPrivateFile(file, toml.stringify(config as unknown as toml.JsonMap))
  if (reconcileScrollMonitorGrafana(values, config.grafana).length > 0) {
    fs.writeFileSync(valuesFile, yaml.dump(values, {lineWidth: -1, noRefs: true}))
  }
}
