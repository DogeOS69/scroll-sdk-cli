/**
 * Represents an unclaimed withdrawal.
 */
export type Withdrawal = {
	batch_deposit_fee: string;
	block_number: number;
	block_timestamp: number;
	claim_info: ClaimInfo | null;
	counterpart_chain_tx: CounterpartChainTx;
	hash: string;
	l1_token_address: string;
	l2_token_address: string;
	message_hash: string;
	message_type: number;
	refund_tx_hash: string;
	replay_tx_hash: string;
	token_amounts: string[];
	token_ids: string[];
	token_type: number;
	tx_status: number;
};

export interface ClaimInfo {
	claimable: boolean;
	from: string;
	message: string;
	nonce: string;
	proof: Proof;
	to: string;
	value: string;
}

export interface Proof {
	batch_index: string;
	merkle_proof: string;
}

export interface CounterpartChainTx {
	block_number: number;
	hash: string;
}

/** API response structure for withdrawal results */
interface WithdrawalApiResult {
	batch_deposit_fee: string;
	block_number: number;
	block_timestamp: number;
	claim_info: {
		claimable: boolean;
		from: string;
		message: string;
		nonce: string;
		proof: { batch_index: string; merkle_proof: string };
		to: string;
		value: string;
	} | null;
	counterpart_chain_tx: { block_number: number; hash: string };
	from: string;
	hash: string;
	l1_token_address: string;
	l2_token_address: string;
	message_hash: string;
	message_type: number;
	nonce: string;
	refund_tx_hash: string;
	replay_tx_hash: string;
	to: string;
	token_amounts: string[];
	token_ids: string[];
	token_type: number;
	tx_status: number;
	value: string;
}

/**
 * Retrieves unclaimed withdrawals for a given address.
 * 
 * @param address - The address to check for unclaimed withdrawals.
 * @param apiUri - The URI of the API to query for unclaimed withdrawals.
 * @returns A promise that resolves to an array of UnclaimedWithdrawal objects.
 * @throws An error if the API request fails or returns an error.
 */
export async function getWithdrawals(address: string, apiUri: string): Promise<Withdrawal[]> {
	const url = `${apiUri}/l2/withdrawals?address=${address}&page=1&page_size=100`;

	const response = await fetch(url);
	if (!response.ok) {
		throw new Error(`HTTP error! status: ${response.status}`);
	}

	const data = await response.json();

	if (data.errcode !== 0) {
		throw new Error(`API error: ${data.errmsg}`);
	}

	const withdrawals: Withdrawal[] = (data.data.results as WithdrawalApiResult[]).map((result) => ({
		batch_deposit_fee: result.batch_deposit_fee,
		block_number: result.block_number,
		block_timestamp: result.block_timestamp,
		claim_info: result.claim_info ? {
			claimable: result.claim_info.claimable,
			from: result.claim_info.from,
			message: result.claim_info.message,
			nonce: result.claim_info.nonce,
			proof: {
				batch_index: result.claim_info.proof.batch_index,
				merkle_proof: result.claim_info.proof.merkle_proof
			},
			to: result.claim_info.to,
			value: result.claim_info.value
		} : null,
		counterpart_chain_tx: {
			block_number: result.counterpart_chain_tx.block_number,
			hash: result.counterpart_chain_tx.hash
		},
		hash: result.hash,
		l1_token_address: result.l1_token_address,
		l2_token_address: result.l2_token_address,
		message_hash: result.message_hash,
		message_type: result.message_type,
		refund_tx_hash: result.refund_tx_hash,
		replay_tx_hash: result.replay_tx_hash,
		token_amounts: result.token_amounts,
		token_ids: result.token_ids,
		token_type: result.token_type,
		tx_status: result.tx_status,
	}));

	return withdrawals;
}