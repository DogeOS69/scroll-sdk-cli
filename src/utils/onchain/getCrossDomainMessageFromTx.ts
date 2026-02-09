import { Contract, ethers } from 'ethers';

import { RpcSource, generateProvider } from './index.js';

/**
 * Retrieves cross-domain message information from a transaction.
 * 
 * @param tx - The transaction hash.
 * @param rpc - The RPC source to use for querying the blockchain.
 * @param l1MessageQueueProxyAddress - The address of the L1 message queue proxy contract.
 * @returns A promise that resolves to an object containing the queue index and L2 transaction hash.
 * @throws An error if the transaction is not found or if the QueueTransaction event is not found.
 */
export async function getCrossDomainMessageFromTx(
  tx: string,
  rpc: RpcSource,
  l1MessageQueueProxyAddress: string
): Promise<{ l2TxHash: string; queueIndex: number }> {
  const provider = generateProvider(rpc)
  const receipt = await provider.getTransactionReceipt(tx);
  if (!receipt) throw new Error('Transaction not found');


  const queueTransactionLog = receipt.logs.find(log =>
    log.address.toLowerCase() === l1MessageQueueProxyAddress.toLowerCase()
  );

  if (!queueTransactionLog) throw new Error('QueueTransaction event not found');
  /*
  event QueueTransaction(
        address indexed sender,
        address indexed target,
        uint256 value,
        uint64 queueIndex,
        uint256 gasLimit,
        bytes data
    );
  */
  const decodedLog = ethers.AbiCoder.defaultAbiCoder().decode(
    ['uint256', 'uint64', 'uint256', 'bytes'],
    queueTransactionLog.data
  );

   const value=decodedLog[0]
   const queueIndex=decodedLog[1]
   const gasLimit=decodedLog[2]
   const data=decodedLog[3]
   const sender = ethers.AbiCoder.defaultAbiCoder().decode(['address'], queueTransactionLog.topics[1])[0]
   const target = ethers.AbiCoder.defaultAbiCoder().decode(['address'], queueTransactionLog.topics[2])[0]
  const l1MessageQueueABI = [
    // "function getCrossDomainMessage(uint256) view returns (bytes32)",
    "function getMessageRollingHash(uint256 queueIndex) external view returns (bytes32 hash)",
    /*
    https://github.com/scroll-tech/scroll-contracts/blob/8e6a02b120d3a997f7c8e948b62bfb0e5b3ac185/src/L1/rollup/L1MessageQueueV2.sol#L190
        function computeTransactionHash(
        address sender,
        uint256 queueIndex,
        uint256 value,
        address target,
        uint256 gasLimit,
        bytes calldata data
    ) external view returns (bytes32);
    */
    "function computeTransactionHash(address,uint256,uint256,address,uint256,bytes) external view returns (bytes32)"
  ];
  const l1MessageQueue = new Contract(l1MessageQueueProxyAddress, l1MessageQueueABI, provider);
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