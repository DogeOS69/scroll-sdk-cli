import {keccak256} from 'ethers'

type ObjectValue = Record<string, unknown>
function object(value: unknown): ObjectValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid protocol context')
  return value as ObjectValue
}

function hex(value: unknown, bytes: number): string {
  if (typeof value !== 'string' || !new RegExp(`^(0x)?[0-9a-fA-F]{${bytes * 2}}$`).test(value)) throw new Error('Invalid protocol context hash')
  return value.replace(/^0x/, '').toLowerCase()
}

/** Core canonical encoding: BE integers/RPC txid, but consensus-order Dogecoin block hash. */
export function rotationProtocolOpeningId(context: unknown): string {
  const source = object(context)
  const protocol = object(source.protocol)
  const genesis = object(source.genesis)
  const outpoint = object(genesis.genesis_sequencer_outpoint)
  const numeric = (value: unknown, size: number): Buffer => {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error('Invalid protocol context integer')
    const result = Buffer.alloc(size)
    if (size === 8) result.writeBigUInt64BE(BigInt(value))
    else result.writeUIntBE(value, 0, size)
    return result
  }

  const bytes = (value: unknown, count: number): Buffer => Buffer.from(hex(value, count), 'hex')
  return keccak256(Buffer.concat([
    numeric(protocol.protocol_version, 2), numeric(protocol.dogecoin_chain_id, 4), numeric(protocol.l2_chain_id, 4), numeric(protocol.eth_chain_id, 8),
    bytes(outpoint.txid, 32), numeric(outpoint.vout, 4), bytes(genesis.genesis_bridge_key_hash, 20), numeric(genesis.initial_confirmed_block_number, 4),
    bytes(genesis.initial_confirmed_block_hash, 32).reverse(), bytes(genesis.initial_ethereum_block_hash, 32), numeric(genesis.initial_tx_index, 4),
    bytes(genesis.genesis_batch_hash, 32), bytes(genesis.genesis_state_root, 32), bytes(genesis.initial_system_signer, 20),
  ])).slice(2)
}
