import * as toml from '@iarna/toml'
import * as yaml from 'js-yaml'
import * as fs from 'node:fs'
import * as path from 'node:path'

import type {DstackControllerConfig} from '../types/dstack-controller.js'

import {validateDstackControllerConfig} from './dstack-controller-values.js'
import {writePrivateFile} from './dstack-credentials.js'

export function readDstackControllerConfig(file?: string, spec?: string): DstackControllerConfig | undefined {
  const target = path.resolve(spec ?? file ?? '.data/doge-config.toml')
  if (spec && file) throw new Error('Choose --spec or --doge-config, not both')
  if (!fs.existsSync(target) && file === undefined && spec === undefined) return undefined
  let config: unknown
  try {
    const contents = fs.readFileSync(target, 'utf8')
    config = (spec ? yaml.load(contents) as Record<string, unknown> : toml.parse(contents)).dstackController
  } catch {
    throw new Error('Cannot read dstack deployment configuration; contents omitted')
  }

  validateDstackControllerConfig(config)
  return config as DstackControllerConfig | undefined
}

export function usesDstackPostgres(config?: DstackControllerConfig): boolean {
  return config !== undefined && config.enabled !== false && config.database?.type !== 'sqlite'
}

/** Reject invalid URLs without including credentials in errors. */
export function parseDatabaseUrl(value: string): URL {
  try {
    const url = new URL(value)
    if (!['postgres:', 'postgresql+asyncpg:', 'postgresql:'].includes(url.protocol) || !url.hostname || url.pathname.length < 2) throw new Error('invalid')
    return url
  } catch {
    throw new Error('Invalid PostgreSQL connection string; expected a PostgreSQL URL with host and database')
  }
}

export function databasePassword(value: string): string {
  try {
    return decodeURIComponent(parseDatabaseUrl(value).password)
  } catch {
    throw new Error('Cannot read password from PostgreSQL connection string')
  }
}

export function buildDatabaseUrl(options: {
  database: string; dstack: boolean; host: string; password: string; port: string; sslMode?: string; user: string
}): string {
  const mode = options.sslMode ?? 'require'
  if (!['allow', 'disable', 'prefer', 'require', 'verify-ca', 'verify-full'].includes(mode)) throw new Error('Unsupported database SSL mode')
  if (!/^\d+$/.test(options.port) || Number(options.port) < 1 || Number(options.port) > 65_535) throw new Error('Invalid PostgreSQL port')
  if (!options.host || /[\s#/?@]/.test(options.host)) throw new Error('Invalid PostgreSQL host')
  const host = options.host.includes(':') && !options.host.startsWith('[') ? `[${options.host}]` : options.host
  const encode = (value: string) => encodeURIComponent(value).replaceAll(/[!'()*]/g, character => `%${character.codePointAt(0)!.toString(16).toUpperCase()}`)
  const scheme = options.dstack ? 'postgresql+asyncpg' : 'postgres'
  // SQLAlchemy's asyncpg dialect passes query options directly to asyncpg.
  const sslParameter = options.dstack ? 'ssl' : 'sslmode'
  return `${scheme}://${encode(options.user)}:${encode(options.password)}@${host}:${options.port}/${encode(options.database)}?${sslParameter}=${mode}`
}

/** Render locally only. Applying this Secret is a separate deployment operation. */
export function writeDstackDatabaseSecret(directory: string, url: string, config?: DstackControllerConfig): string {
  validateDstackControllerConfig(config)
  const parsed = parseDatabaseUrl(url)
  if (parsed.protocol !== 'postgresql+asyncpg:' || parsed.searchParams.has('sslmode')) {
    throw new Error('Dstack requires a postgresql+asyncpg URL with ssl rather than sslmode; rerun setup db-init --databases dstack')
  }

  const name = config?.database?.existingSecret ?? 'dstack-controller-database'
  const key = config?.database?.key ?? 'database-url'
  if (name.length > 253 || !/^[\da-z]([\d.a-z-]*[\da-z])?$/.test(name)) throw new Error('Invalid dstack database Secret name')
  if (key.length > 253 || !/^[\w.-]+$/.test(key)) throw new Error('Invalid dstack database Secret key')
  fs.mkdirSync(directory, {recursive: true})
  const target = path.join(directory, `${name}.yaml`)
  const content = yaml.dump({
    apiVersion: 'v1', kind: 'Secret', metadata: {name}, stringData: {[key]: url}, type: 'Opaque',
  }, {lineWidth: -1, noRefs: true})
  writePrivateFile(target, content)
  return target
}
