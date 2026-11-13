import {Flags} from '@oclif/core'
import fs from 'node:fs'
import path from 'node:path'

import type {JsonOutputContext} from './json-output.js'

import {CAPACITY_DOCUMENT} from './capacity-document.js'
import {createCapacityDocument} from './capacity-runtime.js'
import {DEFAULT_DEPLOYMENT} from './deployment-paths.js'

export const capacityFlags = {
  dir: Flags.string({aliases: ['deployment-dir'], default: DEFAULT_DEPLOYMENT, description: 'Prepared deployment directory holding capacity.yaml and values/'}),
  'env-file': Flags.string({description: 'Private NAME=value file with provider credentials (default: the file saved by setup plan, or ./deployment.env)'}),
  json: Flags.boolean({default: false, description: 'Output structured JSON; never prints credentials'}),
  'skip-provider-check': Flags.boolean({default: false, description: 'Do not check a new or changed Vast.ai API key with Vast.ai'}),
}

/**
 * A deployment prepared before capacity.yaml existed gets it on its first capacity command, which then stops:
 * the operator reviews the file first. Returns whether it was created.
 */
export function startCapacityDocument(dir: string, output: JsonOutputContext): boolean {
  if (!fs.existsSync(path.join(dir, '.scrollsdk/intent.json'))) {
    throw new Error(`${path.resolve(dir)} is not a prepared deployment directory (no .scrollsdk/intent.json). Run from the directory that contains it (the default --dir is ${DEFAULT_DEPLOYMENT}), or pass --dir`)
  }

  const created = createCapacityDocument(dir)
  if (!created) return false
  for (const warning of created.warnings) output.addWarning(warning)
  output.logSuccess(`Wrote ${dir}/${CAPACITY_DOCUMENT} from the current deployment; nothing else changed. Review and edit it, then run the same command again.`)
  output.success({created: CAPACITY_DOCUMENT, document: created.document})
  return true
}
