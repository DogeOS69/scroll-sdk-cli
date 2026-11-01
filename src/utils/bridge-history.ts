import type {DeploymentSpec} from '../types/deployment-spec.js'

export const HISTORY_SERVICE = 'dogeos-bridge-history'
export const HISTORY_VALUES = `${HISTORY_SERVICE}-production.yaml`
export const HISTORY_API = '/api/history/v1'

/** The image is not part of older Core releases; never guess a compatible tag. */
export function validateBridgeHistory(spec: DeploymentSpec): void {
  if (spec.bridgeHistory && typeof spec.bridgeHistory.enabled !== 'boolean') throw new Error('bridgeHistory.enabled must be a boolean')
  if (!spec.bridgeHistory?.enabled) return
  for (const service of ['dogeosBridgeHistory', 'frontends'] as const) {
    const tag = spec.images?.services?.[service]?.tag
    if (typeof tag !== 'string' || !tag || /todo|<|>|\$env:|^(?:latest|head|canary)$/i.test(tag)) throw new Error(`bridgeHistory requires images.services.${service}.tag to select an explicit published release`)
  }

  if (spec.images?.services?.frontends?.tag === '0.3.0-test.20261011.4') throw new Error('bridgeHistory requires an Activity-enabled Portal image; 0.3.0-test.20261011.4 uses the retired API')
  if (spec.infrastructure.provider === 'aws') {
    const services = spec.infrastructure.aws?.sharedAlb?.services ?? []
    if (!services.includes(HISTORY_SERVICE) || !services.includes('frontends')) throw new Error('bridgeHistory requires sharedAlb.services to include dogeos-bridge-history and frontends for same-origin routing')
  }
}

export function frontendHistoryEnv(): Record<string, string> {
  return {
    REACT_APP_HISTORY_API_URI: HISTORY_API,
  }
}

/** Only deployment identity is projected; polling, storage and resources remain values policy. */
export function historyConfig(network: string, startHeight: number) {
  if (!['dogecoin', 'mainnet', 'regtest', 'testnet'].includes(network)) throw new Error('bridgeHistory requires a valid Dogecoin network')
  if (!Number.isSafeInteger(startHeight) || startHeight < 0) throw new Error('bridgeHistory requires a non-negative dogecoinIndexerStartHeight')
  return {dogecoin_indexer: {start_height: startHeight}, network: network === 'dogecoin' ? 'mainnet' : network}
}

/**
 * The L2 indexer and Ethereum DA inbox the service reads, from the withdrawal
 * processor's sources. The Ethereum RPC URL is a Secret (ETHEREUM_RPC_KEYS);
 * the batcher is omitted until the eth-da-submitter key exists.
 */
export function historyChainConfig(input: {expectedBatcher?: string; inboxStartBlock: number; l2MessageQueue: string; l2RpcUrl: string}) {
  if (!Number.isSafeInteger(input.inboxStartBlock) || input.inboxStartBlock < 0) throw new Error('bridgeHistory requires a non-negative Ethereum DA inbox start block')
  return {
    ethereum: {...(input.expectedBatcher ? {expected_batchers: [input.expectedBatcher]} : {}), start_block: input.inboxStartBlock},
    l2: {message_queue_address: input.l2MessageQueue, rpc_url: input.l2RpcUrl, start_block: 0},
  }
}
