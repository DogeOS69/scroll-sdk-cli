import * as toml from '@iarna/toml'
import * as yaml from 'js-yaml'
import fs from 'node:fs'
import path from 'node:path'

import {privateWrite} from './preparation-io.js'

/** Package existing public inputs; never rerun genesis or embed config.toml. */
export function writeContractsHelmValues(root: string, valuesDir = path.join(root, 'values')): void {
  const outputs = [
    {key: 'scrollConfig', source: 'config.public.toml', target: 'scroll-common-config.yaml'},
    {key: 'scrollConfigContracts', source: 'config-contracts.toml', target: 'scroll-common-config-contracts.yaml'},
  ].map(file => {
    const source = path.join(root, file.source)
    if (!fs.existsSync(source)) throw new Error(`Missing ${file.source}; generate contract artifacts before rendering Helm values`)
    const content = fs.readFileSync(source, 'utf8')
    try {toml.parse(content)} catch {throw new Error(`Invalid ${file.source} (contents omitted)`)}
    return {content: yaml.dump({[file.key]: content}, {indent: 2}), target: path.join(valuesDir, file.target)}
  })
  // Validate both inputs before replacing either output.
  for (const output of outputs) privateWrite(output.target, output.content)
}
