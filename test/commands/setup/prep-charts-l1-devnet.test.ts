/* eslint-disable @typescript-eslint/no-explicit-any -- Exercise the preparation boundary without deployment credentials. */
import {expect} from 'chai'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import PrepCharts from '../../../src/commands/setup/prep-charts.js'

describe('setup prep-charts excludes development-only Ethereum', () => {
  for (const chain of [undefined, 'sepolia', 'mainnet']) it(`leaves unused L1 devnet values untouched for ${chain ?? 'unspecified'} Ethereum`, async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'prep-external-ethereum-'))
    try {
      const file = path.join(directory, 'l1-devnet-production.yaml')
      // Skipping must happen before YAML parsing or any certificate validation.
      const original = 'unused-invalid-yaml: ['
      fs.writeFileSync(file, original)
      const command = Object.create(PrepCharts.prototype) as any
      command.dogeConfig = {ethereumDa: {chain}, network: 'testnet'}
      command.getConfigValue = () => {}
      command.jsonCtx = {info() {}}
      expect(await command.processProductionYaml(directory)).to.deep.equal({skipped: 1, updated: 0})
      expect(fs.readFileSync(file, 'utf8')).to.equal(original)
    } finally {
      fs.rmSync(directory, {force: true, recursive: true})
    }
  })
})
