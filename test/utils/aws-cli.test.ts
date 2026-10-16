import {expect} from 'chai'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {AwsCliRunner} from '../../src/utils/aws-cli.js'

describe('aws-cli runner', () => {
  it('never echoes arguments when aws fails without stderr', () => {
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'aws-cli-'))
    const originalPath = process.env.PATH
    try {
      fs.writeFileSync(path.join(bin, 'aws'), '#!/bin/sh\nkill -9 $$\n', {mode: 0o755})
      process.env.PATH = `${bin}:${originalPath}`
      expect(() => new AwsCliRunner().json(['secretsmanager', 'put-secret-value', '--secret-string', 'placeholder-must-not-leak']))
        .to.throw('aws secretsmanager put-secret-value failed')
        .with.property('message').that.does.not.include('placeholder-must-not-leak')
    } finally {
      process.env.PATH = originalPath
      fs.rmSync(bin, {force: true, recursive: true})
    }
  })
})
