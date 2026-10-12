import {validateAttestationSignerIdentity} from './attestation-signer-descriptor.js'
import {type RotationSpec, validateRotationSpec} from './bridge-rotation.js'

/** Accept only the core public exchange format, not private env files or SDK helper output. */
export function rotationSpecFromIdentities(name: string, network: unknown, records: {identity: unknown; name: string}[], threshold?: number, timelock: 'preserve' | 'refresh' = 'preserve'): RotationSpec {
  if (!['mainnet', 'regtest', 'testnet'].includes(String(network))) throw new Error('Deployment Dogecoin network is missing')
  const signers = records.map(record => {
    let identity
    try {identity = validateAttestationSignerIdentity(record.identity, 'core identity')} catch {throw new Error(`Invalid core identity for ${/^[\da-z-]+$/.test(record.name) ? record.name : 'signer'}; obtain --print-identity output, not private keys or public-identity.json`)}
    if (identity.network !== network) throw new Error('Signer identity network differs from the bridge deployment')
    return {attestationPubkey: identity.publicKey, name: record.name, transportPubkey: identity.transportPubkey}
  })
  return validateRotationSpec({attestation: {signers, ...(threshold === undefined ? {} : {threshold})}, name, timelock: {policy: timelock}})
}
