import { AttestationSignerCommand } from './attestation-signer.js'

export default class DummySignersCommand extends AttestationSignerCommand {
  static description = 'Deprecated: use `scrollsdk setup attestation-signer` instead'
  static examples = ['$ scrollsdk setup attestation-signer']
  static hidden = true

  async run(): Promise<void> {
    this.warn('`scrollsdk setup dummy-signers` is deprecated; use `scrollsdk setup attestation-signer` instead.')
    await super.run()
  }
}
