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
	token_ids: any[];
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

	try {
		const response = await fetch(url);
		if (!response.ok) {
			throw new Error(`HTTP error! status: ${response.status}`);
		}

		const data = await response.json();

		if (data.errcode !== 0) {
			throw new Error(`API error: ${data.errmsg}`);
		}

		const withdrawals: Withdrawal[] = data.data.results.map((result: any) => ({
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
			from: result.from,
			hash: result.hash,
			nonce: result.nonce,
			to: result.to,
			tx_status: result.tx_status,
			value: result.value
		}));

		return withdrawals;
	} catch (error) {
		throw error;
	}
}