declare module 'bitcore-lib-doge' {
  export const Networks: {
    livenet: unknown
    testnet: unknown
  }

  export class Address {
    constructor(address: string)
    toString(): string
  }

  export class PrivateKey {
    network: {
      name?: string
    }

    constructor(data?: null | string, network?: unknown)

    static fromWIF(str: string): PrivateKey
    toAddress(): Address
    toPublicKey(): PublicKey
    toWIF(): string
  }

  export class PublicKey {
    toAddress(): Address
  }

  export class Script {
    static buildDataOut(data: Buffer): Script
    static buildPublicKeyHashOut(address: Address | string): Script
    toString(): string
  }

  export class Transaction {
    static FEE_PER_KB: number

    static Input: {
      PublicKeyHash: typeof PublicKeyHashInput
    }

    static Output: typeof Output

    static SIGHASH_ALL: number

    static UnspentOutput: typeof UnspentOutput

    inputs: Input[]

    constructor()

    addData(data: Buffer): void
    addInput(input: Input): void
    addOutput(output: Output): void
    change(address: Address | string): void
    feePerKb(amount: number): void
    from(utxo: UnspentOutput): void
    serialize(): string
    sign(privateKey: PrivateKey): void
    to(address: string, amount: number): void
  }

  export class Input {
    sequenceNumber: number

    constructor(params: {
      output: {
        satoshis: number
        script: string
      }
      outputIndex: number
      prevTxId: string
      script: string
    })
  }

  export class PublicKeyHashInput extends Input {
    constructor(params: {
      output: {
        satoshis: number
        script: string
      }
      outputIndex: number
      prevTxId: string
      script: string
    })

    addSignature(transaction: Transaction, signature: Signature): void
    getSignatures(transaction: Transaction, privateKey: PrivateKey, inputIndex: number, sigtype: number): Signature[]
  }

  export class Output {
    constructor(params: {satoshis: number; script: Script | string})
  }

  export class UnspentOutput {
    satoshis: number
    constructor(params: {address: string; outputIndex: number; satoshis: number; script: string; txId: string})
  }

  export class Signature {
    constructor(params: Record<string, unknown>)
  }
}
