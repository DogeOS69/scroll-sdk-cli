import {createHash} from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

export const digest = (input: Buffer | string): string => createHash('sha256').update(input).digest('hex')
export function privateWrite(file: string, content: Buffer | string): void {
  fs.mkdirSync(path.dirname(file), {mode: 0o700, recursive: true})
  const temporary = `${file}.${process.pid}.new`
  fs.writeFileSync(temporary, content, {flag: 'wx', mode: 0o600})
  fs.renameSync(temporary, file)
}

export function writeJson(file: string, value: unknown): void {privateWrite(file, JSON.stringify(value, null, 2) + '\n')}
export function localPath(root: string, relative: string): string {
  const result = path.resolve(root, relative)
  if (!relative || path.isAbsolute(relative) || result === root || !result.startsWith(root + path.sep)) throw new Error('Workflow paths must remain inside the deployment directory')
  for (let current = result; current !== root; current = path.dirname(current)) {
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw new Error('Workflow paths cannot traverse symlinks')
  }

  return result
}

export class AwaitingInput extends Error {
  constructor(public readonly details: {address?: string; amountSats?: number; file?: string; fundingRequests?: Array<{address: string; amountSats: number; role: string; vout?: number}>; inputTemplate?: Record<string, unknown>; markerScript?: string; message: string}) {super(details.message)}
}


/** Load credentials as data; never evaluate shell syntax or print values. */
export function loadPreparationEnv(file?: string): void {
  if (!file) return
  let content: string
  try {content = fs.readFileSync(file, 'utf8')} catch {throw new Error('Cannot read the declared preparation environment file')}
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const entry = trimmed.match(/^(?:export\s+)?([A-Z_a-z]\w*)=(.*)$/)
    if (!entry) throw new Error('Environment file must contain NAME=value entries')
    let value = entry[2].trim()
    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) value = value.slice(1, -1)
    if (process.env[entry[1]] === undefined) process.env[entry[1]] = value
  }
}
