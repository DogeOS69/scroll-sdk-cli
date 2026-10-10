import {confirm, input, password} from '@inquirer/prompts'
import {spawnSync} from 'node:child_process'
import {randomBytes} from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'

import type {DogeConfig} from '../types/doge-config.js'

import {checkPrivatePath, writePrivateFile} from './dstack-credentials.js'

type GrafanaConfig = NonNullable<DogeConfig['grafana']>
type GrafanaPrompts = {confirm: typeof confirm; input: typeof input; password: typeof password}
const defaultPrompts: GrafanaPrompts = {confirm, input, password}

export function grafanaAdminReference(config: GrafanaConfig) {
  const reference = {
    existingSecret: config.existingSecret ?? 'grafana-admin',
    passwordKey: config.passwordKey ?? 'admin-password',
    userKey: config.userKey ?? 'admin-user',
  }
  if (reference.existingSecret.length > 253 || !/^[\da-z]+(?:[.-][\da-z]+)*$/.test(reference.existingSecret)) {
    throw new Error('grafana.existingSecret must be a Kubernetes Secret name')
  }

  for (const key of ['userKey', 'passwordKey'] as const) {
    if (!/^[\w.-]+$/.test(reference[key]) || reference[key].length > 253) {
      throw new Error(`grafana.${key} must be a Kubernetes Secret data key`)
    }
  }

  if (reference.userKey === reference.passwordKey) throw new Error('Grafana userKey and passwordKey must differ')
  return reference
}

/** Keep environment references in configuration; resolve only when rendering a Secret. */
export async function configureGrafanaAdmin(
  existing: GrafanaConfig = {},
  nonInteractive: boolean,
  prompts: GrafanaPrompts = defaultPrompts,
): Promise<GrafanaConfig> {
  const config = {...existing}
  grafanaAdminReference(config)
  config.adminUser = nonInteractive ? (config.adminUser || 'admin') : await prompts.input({
    default: config.adminUser || 'admin', message: 'Enter the Grafana admin username:',
    validate: value => value.trim() !== '' || 'Grafana admin username is required',
  })
  if (config.adminPassword?.trim() && (nonInteractive || !await prompts.confirm({
    default: false, message: 'Replace the configured Grafana admin password?',
  }))) return config

  const generate = nonInteractive || await prompts.confirm({
    default: true, message: 'Automatically generate a secure Grafana admin password?',
  })
  config.adminPassword = generate ? randomBytes(24).toString('base64url') : await prompts.password({
    mask: '*',
    message: 'Enter the Grafana admin password (or $ENV:VAR_NAME):',
    validate: value => value.trim() !== '' || 'Grafana admin password is required',
  })
  return config
}

/** Exclude local credential files before writing, and refuse already tracked paths. */
export function writeGrafanaPrivateFile(file: string, content: string): void {
  file = path.resolve(file)
  checkPrivatePath(file)
  let directory = path.dirname(file)
  while (!fs.existsSync(directory)) directory = path.dirname(directory)
  const git = (args: string[]) => spawnSync('git', ['-C', directory, ...args], {
    encoding: 'utf8', env: {...process.env, LC_ALL: 'C'},
  })
  const root = git(['rev-parse', '--show-toplevel'])
  if (root.status === 0) {
    const tracked = git(['--literal-pathspecs', 'ls-files', '--error-unmatch', '--', file])
    if (tracked.status === 0) throw new Error('Refusing to write Grafana credentials to a Git-tracked file')
    if (tracked.status !== 1) throw new Error('Cannot check whether the Grafana credential destination is tracked')
    const ignored = git(['check-ignore', '--quiet', '--', file])
    // writePrivateFile uses a temporary sibling for its atomic rename.
    const temporaryIgnored = git(['check-ignore', '--quiet', '--', `${file}.grafana.tmp`])
    if (![0, 1].includes(ignored.status ?? -1) || ![0, 1].includes(temporaryIgnored.status ?? -1)) {
      throw new Error('Cannot check Git exclusions for Grafana credentials')
    }

    if (ignored.status === 1 || temporaryIgnored.status === 1) {
      const exclude = git(['rev-parse', '--path-format=absolute', '--git-path', 'info/exclude'])
      if (exclude.status !== 0) throw new Error('Cannot locate Git exclusions for Grafana credentials')
      const relative = path.relative(root.stdout.trim(), file).split(path.sep).join('/')
      if (/[\n\r]/.test(relative)) throw new Error('Invalid Grafana credential file path')
      const pattern = relative.replaceAll(/[ !#*?[\\\]]/g, '\\$&')
      fs.mkdirSync(path.dirname(exclude.stdout.trim()), {recursive: true})
      fs.appendFileSync(exclude.stdout.trim(), `\n/${pattern}\n/${pattern}.*.tmp\n`)
    }
  } else if (root.error || !root.stderr.includes('not a git repository')) {
    throw new Error('Cannot check Git protection for Grafana credentials')
  }

  writePrivateFile(file, content)
}

export function writeGrafanaAdminSecret(config: GrafanaConfig, directory = process.cwd()): string {
  const reference = grafanaAdminReference(config)
  const resolve = (field: 'adminPassword' | 'adminUser', fallback?: string) => {
    const source = config[field] ?? fallback
    const match = source?.match(/^\$ENV:(\w+)$/)
    const value = match ? process.env[match[1]] : source
    if (!value?.trim()) throw new Error(`grafana.${field} is required; set its value or referenced environment variable`)
    return value
  }

  // Match Dogecoin's local ENV -> push-secrets -> external secret store flow.
  const entries = {
    [reference.passwordKey]: resolve('adminPassword'),
    [reference.userKey]: resolve('adminUser', 'admin'),
  }
  for (const value of Object.values(entries)) {
    if (/[\n\r]/.test(value)) throw new Error('Grafana credentials must be single-line values for secret-store upload')
  }

  const file = path.join(directory, 'secrets', `${reference.existingSecret}.env`)
  const content = Object.entries(entries).map(([key, value]) => `${key}="${value}"\n`).join('')
  writeGrafanaPrivateFile(file, content)
  return file
}
