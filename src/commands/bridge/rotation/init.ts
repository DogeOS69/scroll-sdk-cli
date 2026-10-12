import * as toml from '@iarna/toml'
import {Command, Flags} from '@oclif/core'
import * as yaml from 'js-yaml'
import fs from 'node:fs'
import path from 'node:path'

import {rotationCommand, runtimeDirectory, writeRotationFile} from '../../../utils/bridge-rotation-files.js'
import {rotationSpecFromIdentities} from '../../../utils/bridge-rotation-onboarding.js'

export default class RotationInit extends Command {
  static description = 'Create a rotation intent from authenticated core --print-identity records; never generate keys or access the cluster'
  static flags = {
    dir: Flags.string({default: '.', description: 'Existing bridge deployment directory'}),
    identity: Flags.string({description: 'Repeat NAME=FILE for each approved core identity JSON from Governance; NAME must be unique across old and new registrations', multiple: true, required: true}),
    'rotation-dir': Flags.string({description: 'New private directory for this rotation; its basename becomes the proposal name', required: true}),
    threshold: Flags.integer({description: 'New attestation quorum; omitted preserves the current bridge threshold', min: 1}),
    timelock: Flags.string({default: 'preserve', description: 'Recovery-height intent; refresh must be reviewed by all operators', options: ['preserve', 'refresh']}),
  }

  async run(): Promise<void> {
    const {flags} = await this.parse(RotationInit)
    const root = path.resolve(flags.dir)
    const dir = path.resolve(root, flags['rotation-dir'])
    if (fs.existsSync(dir)) throw new Error('Rotation directory already exists; choose a new directory. Existing proposals are never overwritten')
    let network: unknown
    try {network = toml.parse(fs.readFileSync(path.join(runtimeDirectory(root), '.data/doge-config.toml'), 'utf8')).network} catch {throw new Error('Cannot read deployment network from runtime/.data/doge-config.toml')}
    const identities = flags.identity.map(input => {
      const separator = input.indexOf('=')
      if (separator < 1 || separator === input.length - 1) throw new Error('Use --identity NAME=FILE; save only the approved core public identity JSON in FILE')
      let identity: unknown
      try {identity = JSON.parse(fs.readFileSync(path.resolve(root, input.slice(separator + 1)), 'utf8'))} catch {throw new Error('Cannot read public identity JSON; check the supplied file without publishing its contents')}
      return {identity, name: input.slice(0, separator)}
    })
    const spec = rotationSpecFromIdentities(path.basename(dir), network, identities, flags.threshold, flags.timelock as 'preserve' | 'refresh')
    writeRotationFile(path.join(dir, 'rotation-spec.yaml'), yaml.dump(spec, {lineWidth: -1, noRefs: true}))
    this.log(JSON.stringify({directory: dir, next: rotationCommand('plan', {dir: root, rotationDir: dir}), signers: spec.attestation.signers.map(s => s.name), threshold: spec.attestation.threshold ?? 'inherit current bridge', timelock: flags.timelock}, null, 2))
  }
}
