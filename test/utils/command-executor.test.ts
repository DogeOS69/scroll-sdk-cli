import { expect } from 'chai'
import { executeCommand } from '../../src/utils/command-executor.js'

describe('executeCommand', () => {
  it('resolves with correct stdout and stderr for a successful command', async () => {
    const { stdout, stderr } = await executeCommand('echo test-output');
    expect(stdout).to.equal('test-output');
    expect(stderr).to.equal('');
  }).timeout(5000);
}); 