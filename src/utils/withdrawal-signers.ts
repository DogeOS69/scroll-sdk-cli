/* eslint-disable @typescript-eslint/no-explicit-any -- Native TOML and Helm values documents. */
import bitcore from 'bitcore-lib-doge'

export const WITHDRAWAL_SEQUENCER_KEY_ENV = 'DOGEOS_WITHDRAWAL_SEQUENCER_SIGNER_KEY'

export function withdrawalSequencerKms(config: any): {endpoint_url?: string; expected_pubkey: string; key_id: string; region: string} | undefined {
  const kms = config.sequencer_signer_kms
  if (kms === undefined) return undefined
  if (config.sequencer_signer_key !== undefined) throw new Error('Withdrawal sequencer local key and KMS backend are mutually exclusive')
  if (!kms || typeof kms !== 'object' || Array.isArray(kms) || Object.keys(kms).some(key => !['endpoint_url', 'expected_pubkey', 'key_id', 'region'].includes(key))) throw new Error('Invalid withdrawal sequencer KMS configuration')
  for (const field of ['key_id', 'region', 'expected_pubkey']) if (typeof kms[field] !== 'string' || !kms[field].trim()) throw new Error(`Withdrawal sequencer KMS requires ${field}`)
  if (!/^(02|03)[\da-f]{64}$/.test(kms.expected_pubkey)) throw new Error('Withdrawal sequencer KMS requires a pinned compressed public key')
  bitcore.PublicKey.fromString(kms.expected_pubkey)
  if (kms.endpoint_url !== undefined && (typeof kms.endpoint_url !== 'string' || !kms.endpoint_url.trim())) throw new Error('Invalid withdrawal sequencer KMS endpoint')
  return {...kms}
}

/** KMS metadata lives in native TOML, never in an env override or a WIF Secret. */
export function reconcileWithdrawalSignerValues(values: any, config: any): boolean {
  const kms = withdrawalSequencerKms(config)
  const before = JSON.stringify(values)
  const stale = (name: string) => name.startsWith('DOGEOS_WITHDRAWAL_SEQUENCER_SIGNER_KMS__') || Boolean(kms && name === WITHDRAWAL_SEQUENCER_KEY_ENV)
  if (Array.isArray(values.env)) values.env = values.env.filter((entry: any) => !stale(entry.name ?? ''))
  for (const key of Object.keys(values.configMaps?.env?.data ?? {})) if (stale(key)) delete values.configMaps.env.data[key]
  if (kms) {
    for (const secret of Object.values(values.externalSecrets ?? {}) as any[]) {
      if (Array.isArray(secret.data)) secret.data = secret.data.filter((entry: any) => entry.secretKey !== WITHDRAWAL_SEQUENCER_KEY_ENV)
    }
  }

  return before !== JSON.stringify(values)
}
