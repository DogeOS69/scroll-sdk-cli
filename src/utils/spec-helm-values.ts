import * as yaml from 'js-yaml'
import fs from 'node:fs'

import type {DeploymentSpec} from '../types/deployment-spec.js'

import {localPath, privateWrite} from './preparation-io.js'
import {mergeBootstrapValues} from './spec-bootstrap.js'

/** Overlays enter the standard values files, so every normal Make target consumes them. */
export function applyHelmValues(files: Record<string, string>, spec: Pick<DeploymentSpec, 'helmValues'>): void {
  const updates: Record<string, string> = {}
  for (const [name, content] of Object.entries(spec.helmValues ?? {})) {
    if (!/^[\w-]+\.yaml$/.test(name) || !Object.hasOwn(files, name)) throw new Error(`helmValues must select an existing generated values filename: ${name}`)
    let value: unknown
    try {value = yaml.load(content)} catch {throw new Error(`Invalid helmValues YAML for ${name}; contents omitted`)}
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`helmValues.${name} must contain a YAML mapping`)
    // Treat the overlay as operator-owned input: arrays replace, named env entries merge.
    updates[name] = mergeBootstrapValues(files[name], '{}', content)
  }

  Object.assign(files, updates)
}

export function writeHelmValues(root: string, spec: Pick<DeploymentSpec, 'helmValues'>): void {
  const files: Record<string, string> = {}
  for (const name of Object.keys(spec.helmValues ?? {})) {
    if (!/^[\w-]+\.yaml$/.test(name)) throw new Error('helmValues keys must be generated values filenames')
    files[name] = fs.readFileSync(localPath(root, `values/${name}`), 'utf8')
  }

  applyHelmValues(files, spec)
  for (const [name, content] of Object.entries(files)) privateWrite(localPath(root, `values/${name}`), content)
}
