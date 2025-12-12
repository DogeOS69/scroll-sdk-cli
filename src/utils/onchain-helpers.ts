import { Contract, JsonRpcProvider, Wallet, ethers } from 'ethers';
import terminalLink from 'terminal-link';

type RpcSource = JsonRpcProvider | Wallet | string;

export class OnchainHelpers {
  private provider: JsonRpcProvider;

  constructor(rpcSource: RpcSource) {
    this.provider = this.generateProvider(rpcSource);
  }

  async addressLink(address: string, params: BlockExplorerParams = {}): Promise<string> {
    const explorerUrl = await this.constructBlockExplorerUrl(address, LookupType.ADDRESS, params);
    return terminalLink(address, explorerUrl);
  }

  async awaitTx(txHash: string, timeout: number = 20_000): Promise<ethers.TransactionReceipt | null> {
    let receipt = null;

    while (!receipt) {
      try {
        receipt = await this.provider.getTransactionReceipt(txHash);
      } catch {
        console.log(`Transaction not found yet. Retrying in ${timeout/1000} seconds...`);
      }

      if (!receipt) {
        await new Promise(resolve => setTimeout(resolve, timeout));
      }
    }

    return receipt;
  }

  async constructBlockExplorerUrl(value: string, type: LookupType, params: BlockExplorerParams = {}): Promise<string> {
    let baseUrl = params.blockExplorerURI;

    if (!baseUrl) {
      const chainId = params.chainId || Number((await this.provider.getNetwork()).chainId);
      baseUrl = blockExplorerList[chainId];
    }

    if (!baseUrl) {
      throw new Error("Unable to determine block explorer URL");
    }

    baseUrl = baseUrl.replace(/\/$/, "");
    return `${baseUrl}/${type}/${value}`;
  }

  async getCrossDomainMessageFromTx(tx: string, l1MessageQueueProxyAddress: string): Promise<{ l2TxHash: string, queueIndex: number }> {
    const receipt = await this.provider.getTransactionReceipt(tx);
    if (!receipt) throw new Error('Transaction not found');

    const queueTransactionLog = receipt.logs.find(log => 
      log.address.toLowerCase() === l1MessageQueueProxyAddress.toLowerCase()
    );

    if (!queueTransactionLog) throw new Error('QueueTransaction event not found');

    const decodedLog = ethers.AbiCoder.defaultAbiCoder().decode(
      ['uint256', 'uint64', 'uint256', 'bytes'],
      queueTransactionLog.data
    );
    
    const l1MessageQueueABI = [
      "function computeTransactionHash(address,uint256,uint256,address,uint256,bytes) external view returns (bytes32)"

    ];
    const value=decodedLog[0]
    const queueIndex=decodedLog[1]
    const gasLimit=decodedLog[2]
    const data=decodedLog[3]
    const sender = ethers.AbiCoder.defaultAbiCoder().decode(['address'], queueTransactionLog.topics[1])[0]
    const target = ethers.AbiCoder.defaultAbiCoder().decode(['address'], queueTransactionLog.topics[2])[0]

    const l1MessageQueue = new Contract(l1MessageQueueProxyAddress, l1MessageQueueABI, this.provider);

    const l2TxHash = await l1MessageQueue.computeTransactionHash(
      sender,
      queueIndex,
      value,
      target,
      gasLimit,
      data
    );

    return { l2TxHash, queueIndex };
  }

  async getFinalizedBlockHeight(): Promise<number> {
    const result = await this.provider.send("eth_getBlockByNumber", ["finalized", false]);
    return Number.parseInt(result.number, 16);
  }

  async getGasOracleL2BaseFee(l1MessageQueueProxyAddress: string): Promise<bigint> {
    const l2BaseFeeABI = [
      "function l2BaseFee() view returns (uint256)"
    ];
    const gasOracle = new Contract(l1MessageQueueProxyAddress, l2BaseFeeABI, this.provider);

    return gasOracle.l2BaseFee();
  }

  async getPendingQueueIndex(l1MessageQueueProxyAddress: string): Promise<number> {
    const l1MessageQueueABI = [
      "function pendingQueueIndex() view returns (uint256)"
    ];
    const l1MessageQueue = new Contract(l1MessageQueueProxyAddress, l1MessageQueueABI, this.provider);

    return l1MessageQueue.pendingQueueIndex();
  }

  async txLink(txHash: string, params: BlockExplorerParams = {}): Promise<string> {
    const explorerUrl = await this.constructBlockExplorerUrl(txHash, LookupType.TX, params);
    return terminalLink(txHash, explorerUrl);
  }

  private generateProvider(rpcSource: RpcSource): JsonRpcProvider {
    if (typeof rpcSource === 'string') {
      return new JsonRpcProvider(rpcSource);
    }

 if (rpcSource instanceof Wallet && rpcSource.provider instanceof JsonRpcProvider) {
      return rpcSource.provider;
    }

 if (rpcSource instanceof JsonRpcProvider) {
      return rpcSource;
    }

    throw new Error('Invalid rpcSource. Expected Provider, Wallet with JsonRpcProvider, or string with RPC Url.');
  }
}

export enum LookupType {
  ADDRESS = "address",
  TX = "tx"
}

export interface BlockExplorerParams {
  blockExplorerURI?: string;
  chainId?: number;
}

export const l1ETHGatewayABI = [
  {
    "inputs": [
      {
        "internalType": "uint256",
        "name": "amount",
        "type": "uint256"
      },
      {
        "internalType": "uint256",
        "name": "gasLimit",
        "type": "uint256"
      }
    ],
    "name": "depositETH",
    "outputs": [],
    "stateMutability": "payable",
    "type": "function"
  }
];

const blockExplorerList: Record<number, string> = {
  534_351: "https://sepolia.scrollscan.com/",
  11_155_111: "https://sepolia.etherscan.io/"
};