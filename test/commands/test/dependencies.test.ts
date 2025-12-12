import {expect} from 'chai'
import {runCommand} from '@oclif/test'

// Note: These are integration tests that check actual system dependencies.
// They will pass/fail based on what's installed on the machine.
// For CI, use: npm test -- --grep "test:dependencies" --invert
// Or run in an environment with all dependencies installed.

describe('test:dependencies', () => {
  it('runs test:dependencies and produces output', async () => {
    const {stdout} = await runCommand(['test:dependencies'])
    // The command should produce some output about dependencies
    expect(stdout).to.contain('Dependency Check Results')
  })

  it('runs test:dependencies with --dev flag', async () => {
    const {stdout} = await runCommand(['test:dependencies', '--dev'])
    // Should produce output - content depends on what's installed
    expect(stdout).to.contain('Dependency Check Results')
  })
})