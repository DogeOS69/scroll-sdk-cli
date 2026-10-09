import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
// Container integration test. Inputs are private test fixtures, never live deployment files.
const cli = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [sdk, baselineSpec, compilerIdentity] = process.argv.slice(2).map(value => path.resolve(value));
if (!compilerIdentity)
    throw Error('Usage: node scripts/test-preparation-e2e.mjs SDK_CHECKOUT TEST_SPEC COMPILER_IDENTITY');
const require = createRequire(cli + '/package.json'), yaml = require('js-yaml'), toml = require('@iarna/toml'), { Wallet } = require('ethers'), bitcore = require('bitcore-lib-doge'), { Transaction } = require('bitcoinjs-lib');
process.umask(0o077);
const root = fs.mkdtempSync('/tmp/preparation-production-e2e-'), deployment = root + '/deployment';
console.log(JSON.stringify({
    root
}));
const txs = new Map(), blockHash = 'ca'.repeat(32), ethHash = '0x' + 'ea'.repeat(32), calls = [];
const rpc = http.createServer(async (req, res) => {
    let text = '';
    for await (const p of req)
        text += p;
    const { id, method, params } = JSON.parse(text);
    calls.push(method);
    let result, error;
    if (method === 'eth_chainId')
        result = '0x1';
    else if (method === 'eth_getBlockByNumber')
        result = {
            number: '0x64', hash: ethHash, transactions: []
        };
    else if (method === 'getblockchaininfo')
        result = {
            chain: 'test'
        };
    else if (method === 'getblockcount')
        result = 105;
    else if (method === 'getblockheader')
        result = {
            height: 100, confirmations: 6
        };
    else if (method === 'getblockhash')
        result = blockHash;
    else if (method === 'gettxout') {
        const tx = txs.get(params[0]), out = tx?.outs[params[1]];
        result = out ? {
            value: Number(out.value) / 1e8, confirmations: 6, scriptPubKey: {
                hex: Buffer.from(out.script).toString('hex')
            }
        } : null;
    }
    else if (method === 'getrawtransaction') {
        const tx = txs.get(params[0]);
        result = tx ? {
            hex: tx.toHex(), blockhash: blockHash
        } : null;
    }
    else
        error = {
            code: -32601, message: 'Test RPC does not implement this operation'
        };
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({
        id, jsonrpc: '2.0', result, error
    }));
});
await new Promise(resolve => rpc.listen(0, '127.0.0.1', resolve));
const url = 'http://127.0.0.1:' + rpc.address().port;
const owner = Wallet.createRandom(), seq = new bitcore.PrivateKey(null, bitcore.Networks.testnet), fee = new bitcore.PrivateKey(null, bitcore.Networks.testnet);
const environment = {
    ...process.env, OCLIF_TEST_ROOT: cli
};
delete environment.PREP_SEQ_KEY;
delete environment.DOGECOIN_FEE_WALLET_KEY;
fs.writeFileSync(root + '/environment', `PREP_SEQ_KEY=${seq.toWIF()}\nDOGECOIN_FEE_WALLET_KEY=${fee.toWIF()}\n`);
let spec;
try { spec = yaml.load(fs.readFileSync(baselineSpec, 'utf8')); }
catch { throw Error('Cannot read the private test spec; contents omitted'); }
if (spec.proofTopology?.generation !== 'mock' || spec.proofTopology?.enforcement !== 'observe')
    throw Error('Use a mock/observe test spec');
spec.metadata.name = 'preparation-e2e';
spec.infrastructure.provider = 'local';
spec.infrastructure.sequencerCount = 1;
spec.infrastructure.bootnodeCount = 1;
spec.identities = {
    ethDaSubmitter: {
        action: 'create', backend: 'local'
    }, feeOracle: {
        action: 'create', backend: 'local'
    }, sequencers: [{
            index: 0, nodekey: {
                action: 'create'
            }, signer: {
                action: 'create', backend: 'local'
            }
        }], bootnodes: [{
            index: 0, nodekey: {
                action: 'create'
            }
        }]
};
spec.accounts.owner.address = owner.address;
spec.accounts.deployer = {
    privateKey: owner.privateKey
};
spec.dstackController = {
    enabled: true, database: {
        type: 'sqlite'
    }
};
spec.dogecoin.network = 'testnet';
spec.dogecoin.externalRpc = {
    url, username: 'NONFUNCTIONAL_TEST_USER', password: 'NONFUNCTIONAL_TEST_PASSWORD'
};
spec.ethereumDa.l1RpcUrl = url;
spec.ethereumDa.chainId = 1;
spec.bridge.teePubkey = new bitcore.PrivateKey(null, bitcore.Networks.testnet).toPublicKey().toString();
spec.bridge.timelock = 999999;
delete spec.bridge.seedString;
spec.bridge.confirmationsRequired = 2;
spec.attestationSigners = Array.from({length: spec.bridge.keyCounts.attestation}, (_, index) => ({name: `partner-${index}`, attestationPubkey: new bitcore.PrivateKey().toPublicKey().toString(), transportPubkey: new bitcore.PrivateKey().toPublicKey().toString()}));
spec.bridge.initialAttestationKeyset = {signerIds: spec.attestationSigners.map(s => s.name), threshold: spec.bridge.thresholds.attestation};
const image = 'dogeos69/bridge-genesis-tools@sha256:27e646fd5d9c340926df82f47f7d352fd5333de4e6178c5a8c56aa9637769262';
fs.writeFileSync(root + '/vast-key', 'NONFUNCTIONAL_TEST_VAST_KEY');
spec.preparation = {
    dstack: {
        mode: 'import', providers: ['vastai'], vastaiApiKeyFile: root + '/vast-key'
    }, bridge: {
        mode: 'production', image, production: {
            ethereumAnchor: {
                blockNumber: 100, transactionIndex: 0
            }, sequencerPublicKey: seq.toPublicKey().toString(), sequencerKeyEnv: 'PREP_SEQ_KEY', recoveryPublicKeys: Array.from({
                length: spec.bridge.keyCounts.recovery
            }, () => new bitcore.PrivateKey(null, bitcore.Networks.testnet).toPublicKey().toString())
        }
    }, proofMaterials: {
        mode: 'existing'
    }, inputs: [{
            source: compilerIdentity, destination: '.data/compiler-identity.json'
        }]
};
fs.writeFileSync(root + '/intent.yaml', yaml.dump(spec));
async function cmd(label, args) {
    const out = fs.openSync(root + '/' + label + '.json', 'w'), err = fs.openSync(root + '/' + label + '.log', 'w');
    const code = await new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [cli + '/bin/run.js', 'setup', ...args, '--json'], {
            cwd: root, env: environment, stdio: ['ignore', out, err]
        });
        child.once('error', reject);
        child.once('exit', resolve);
    });
    fs.closeSync(out);
    fs.closeSync(err);
    let data;
    try {
        data = JSON.parse(fs.readFileSync(root + '/' + label + '.json', 'utf8'));
    }
    catch {
    }
    console.log(JSON.stringify({
        label, code, status: data?.data?.status, step: data?.data?.currentStep
    }));
    if (![0, 2].includes(code))
        throw Error(label + ' failed; private logs retained');
    return data?.data;
}
function fund(address, amount, marker = false) {
    const tx = new Transaction();
    tx.addInput(crypto.randomBytes(32), 0);
    tx.addOutput(Buffer.from(bitcore.Script.fromAddress(address).toHex(), 'hex'), BigInt(amount));
    if (marker)
        tx.addOutput(Buffer.from('6a4901' + '00'.repeat(72), 'hex'), 0n);
    txs.set(tx.getId(), tx);
    return {
        txid: tx.getId(), vout: 0
    };
}
try {
    await cmd('01-plan', ['plan', '--spec', root + '/intent.yaml', '--output', deployment, '--sdk-dir', sdk, '--env-file', root + '/environment']);
    let result = await cmd('02-apply', ['apply', '--dir', deployment]);
    if (result?.currentStep !== 'production-wallets')
        throw Error('Expected production wallet funding pause');
    const walletSetup = toml.parse(fs.readFileSync(deployment + '/.data/setup_defaults.toml', 'utf8'));
    const input = {
        sequencer: fund(seq.toAddress().toString(), 42069000), feeWallet: fund(fee.toAddress().toString(), walletSetup.fee_wallet_target_amount)
    };
    const file = deployment + '/.scrollsdk/inputs/bridge-funding.json';
    fs.writeFileSync(file, JSON.stringify(input));
    result = await cmd('03-wallets', ['apply', '--dir', deployment]);
    if (result?.currentStep !== 'production-funding')
        throw Error('Expected marked bridge funding pause');
    const bridge = JSON.parse(fs.readFileSync(deployment + '/.data/bridge.json', 'utf8'));
    const setup = toml.parse(fs.readFileSync(deployment + '/.data/setup_defaults.toml', 'utf8'));
    input.bridge = fund(bridge.p2sh_address, setup.bridge_target_amount, true);
    fs.writeFileSync(file, JSON.stringify(input));
    result = await cmd('04-complete', ['apply', '--dir', deployment]);
    if (result?.status !== 'prepared')
        throw Error('Preparation did not complete');
    await cmd('05-rerun', ['apply', '--dir', deployment]);
    if (calls.some(name => name === 'sendrawtransaction'))
        throw Error('Production preparation broadcast a transaction');
    fs.writeFileSync(root + '/evidence.json', JSON.stringify({
        scope: 'Real rc.4 genesis and beta.6 artifact/compiler commands; synthetic read-only chain RPC; no chain broadcasts or cloud operations', completed: true, rpcMethods: [...new Set(calls)]
    }, null, 2));
    console.log(JSON.stringify({
        root, completed: true
    }));
}
finally {
    rpc.close();
}
