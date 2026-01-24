import { expect } from 'chai';
import sinon from 'sinon';

import type { DeploymentSpec } from '../../src/types/deployment-spec.js';

import {
  generateAllConfigs,
  generateConfigToml,
  generateDogeConfigToml,
  generateSetupDefaultsToml,
  hasEnvRef,
  resolveInlineEnvRefs,
  validateDeploymentSpec,
} from '../../src/utils/deployment-spec-generator.js';

/**
 * Minimal valid DeploymentSpec fixture for testing generators.
 * Contains all required fields with sensible defaults.
 */
function createMinimalSpec(overrides?: Partial<DeploymentSpec>): DeploymentSpec {
  return {
    accounts: {
      deployer: { address: '0x1234567890abcdef1234567890abcdef12345678', privateKey: '$ENV:DEPLOYER_PK' },
      l1CommitSender: { address: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', privateKey: '$ENV:COMMIT_PK' },
      l1FinalizeSender: { address: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', privateKey: '$ENV:FINALIZE_PK' },
      l1GasOracleSender: { address: '0xcccccccccccccccccccccccccccccccccccccccc', privateKey: '$ENV:GAS_L1_PK' },
      l2GasOracleSender: { address: '0xdddddddddddddddddddddddddddddddddddddddd', privateKey: '$ENV:GAS_L2_PK' },
      owner: { address: '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' },
    },
    bridge: {
      confirmationsRequired: 6,
      feeRateSatPerKvb: 100_000,
      feeRecipient: '0x0000000000000000000000000000000000000001',
      fees: { deposit: '0', minWithdrawalAmount: '1000000000000000', withdrawal: '0' },
      keyCounts: { attestation: 3, correctness: 2, recovery: 1 },
      seedString: 'test-seed-string',
      targetAmounts: { bridge: 10_000_000, feeWallet: 5_000_000, sequencer: 8_000_000 },
      thresholds: { attestation: 2, correctness: 1, recovery: 1, sequencer: 1 },
      timelockSeconds: 86_400,
    },
    celestia: {
      indexerStartBlock: 100,
      mnemonic: '$ENV:CELESTIA_MNEMONIC',
      namespace: '0x0102030405060708',
      signerAddress: 'celestia1abc...',
      tendermintRpcUrl: 'http://celestia-rpc:26657',
    },
    contracts: {
      deploymentSalt: '0xabcdef',
      gasOracle: { blobScalar: 1, penaltyFactor: 1, penaltyThreshold: 100, scalar: 1 },
      l1FeeVaultAddr: '0x0000000000000000000000000000000000000002',
    },
    database: {
      admin: { database: 'postgres', host: 'db.local', password: 'adminpw', port: 5432, username: 'postgres' },
      credentials: {
        adminSystemPassword: 'pw1',
        blockscoutPassword: 'pw2',
        bridgeHistoryPassword: 'pw3',
        chainMonitorPassword: 'pw4',
        coordinatorPassword: 'pw5',
        gasOraclePassword: 'pw6',
        rollupExplorerPassword: 'pw7',
        rollupNodePassword: 'pw8',
      },
      databases: {
        adminSystem: 'admin_system_db',
        blockscout: 'blockscout_db',
        bridgeHistory: 'bridge_history_db',
        chainMonitor: 'chain_monitor_db',
        coordinator: 'coordinator_db',
        gasOracle: 'gas_oracle_db',
        rollupExplorer: 'rollup_explorer_db',
        rollupNode: 'rollup_node_db',
      },
    },
    dogecoin: {
      indexerStartHeight: 5_000_000,
      network: 'testnet',
      rpc: { password: 'rpcpass', url: 'http://dogecoin-rpc:22555', username: 'rpcuser' },
      walletPath: '/data/wallet.dat',
    },
    frontend: {
      baseDomain: 'example.com',
      externalUrls: {
        bridgeApi: 'https://bridge-api.example.com',
        l1Explorer: 'https://l1-explorer.example.com',
        l1Rpc: 'https://l1-rpc.example.com',
        l2Explorer: 'https://l2-explorer.example.com',
        l2Rpc: 'https://l2-rpc.example.com',
        rollupScanApi: 'https://rollupscan.example.com',
      },
      hosts: {
        adminDashboard: 'admin.example.com',
        blockscout: 'blockscout.example.com',
        bridgeHistoryApi: 'bridge-history.example.com',
        coordinatorApi: 'coordinator.example.com',
        frontend: 'app.example.com',
        grafana: 'grafana.example.com',
        rollupExplorerApi: 'rollup-explorer.example.com',
        rpcGateway: 'rpc.example.com',
      },
    },
    genesis: {
      baseFeePerGas: 1_000_000_000,
      deployerInitialBalance: '1000000000000000000',
      maxEthSupply: '100000000000000000000000000',
    },
    infrastructure: { bootnodeCount: 1, provider: 'local', sequencerCount: 1 },
    metadata: { environment: 'testnet', name: 'test-deployment' },
    network: {
      daPublisherEndpoint: 'http://da-publisher:8080',
      l1ChainId: 11_155_111,
      l1ChainName: 'Sepolia',
      l1RpcEndpoint: 'http://l1-rpc:8545',
      l2ChainId: 534_351,
      l2ChainName: 'DogeOS Testnet',
      l2RpcEndpoint: 'http://l2-rpc:8545',
      tokenSymbol: 'ETH',
    },
    rollup: {
      coordinator: { batchCollectionTimeSec: 60, bundleCollectionTimeSec: 120, chunkCollectionTimeSec: 30, jwtSecretKey: 'jwt-secret' },
      finalization: { batchDeadlineSec: 3600, relayMessageDeadlineSec: 7200 },
      maxBatchInBundle: 20,
      maxBlockInChunk: 100,
      maxL1MessageGasLimit: 10_000_000,
      maxTxInChunk: 100,
    },
    signing: { method: 'local' },
    version: '1.0',
    ...overrides,
  } as DeploymentSpec;
}

describe('deployment-spec-generator', () => {
  afterEach(() => {
    sinon.restore();
  });

  describe('resolveInlineEnvRefs', () => {
    let originalEnv: NodeJS.ProcessEnv;

    beforeEach(() => {
      originalEnv = { ...process.env };
    });

    afterEach(() => {
      process.env = originalEnv;
    });

    it('returns string unchanged when no $ENV: references', () => {
      expect(resolveInlineEnvRefs('hello world')).to.equal('hello world');
    });

    it('resolves single inline env ref', () => {
      // \w+ matches [A-Za-z0-9_], so underscores adjacent to the var name are consumed
      process.env.MY_VAR = 'resolved';
      expect(resolveInlineEnvRefs('prefix/$ENV:MY_VAR/suffix')).to.equal('prefix/resolved/suffix');
    });

    it('resolves multiple inline env refs', () => {
      process.env.HOST = 'db.local';
      process.env.PORT = '5432';
      expect(resolveInlineEnvRefs('postgres://$ENV:HOST:$ENV:PORT/mydb'))
        .to.equal('postgres://db.local:5432/mydb');
    });

    it('throws when referenced env var is not set', () => {
      delete process.env.MISSING_VAR;
      expect(() => resolveInlineEnvRefs('value_$ENV:MISSING_VAR')).to.throw(
        'Environment variable MISSING_VAR is not set'
      );
    });

    it('returns non-string values unchanged', () => {
      expect(resolveInlineEnvRefs(42 as any)).to.equal(42);
    });

    it('resolves env var at start of string', () => {
      process.env.START = 'beginning';
      expect(resolveInlineEnvRefs('$ENV:START/end')).to.equal('beginning/end');
    });

    it('resolves env var at end of string', () => {
      process.env.ENDVAR = 'tail';
      expect(resolveInlineEnvRefs('start_$ENV:ENDVAR')).to.equal('start_tail');
    });
  });

  describe('hasEnvRef', () => {
    it('returns true for string containing $ENV:VAR', () => {
      expect(hasEnvRef('$ENV:MY_SECRET')).to.be.true;
    });

    it('returns true for inline env ref', () => {
      expect(hasEnvRef('prefix_$ENV:DB_PASS_suffix')).to.be.true;
    });

    it('returns false for plain strings', () => {
      expect(hasEnvRef('just-a-value')).to.be.false;
    });

    it('returns false for non-string values', () => {
      expect(hasEnvRef(123 as any)).to.be.false;
    });

    it('returns false for lowercase env refs', () => {
      // Pattern requires uppercase + digits + underscore
      expect(hasEnvRef('$ENV:lowercase')).to.be.false;
    });
  });

  describe('validateDeploymentSpec', () => {
    it('passes validation for a complete spec', () => {
      const spec = createMinimalSpec();
      const result = validateDeploymentSpec(spec);
      expect(result.valid).to.be.true;
      expect(result.errors).to.have.lengthOf(0);
    });

    it('fails on unsupported version', () => {
      const spec = createMinimalSpec({ version: '2.0' as any });
      const result = validateDeploymentSpec(spec);
      expect(result.valid).to.be.false;
      expect(result.errors.some(e => e.code === 'E001_UNSUPPORTED_VERSION')).to.be.true;
    });

    it('fails when metadata.name is missing', () => {
      const spec = createMinimalSpec();
      spec.metadata.name = '';
      const result = validateDeploymentSpec(spec);
      expect(result.errors.some(e => e.path === 'metadata.name')).to.be.true;
    });

    it('fails when metadata.environment is missing', () => {
      const spec = createMinimalSpec();
      (spec.metadata as any).environment = undefined;
      const result = validateDeploymentSpec(spec);
      expect(result.errors.some(e => e.path === 'metadata.environment')).to.be.true;
    });

    it('fails when infrastructure.provider is missing', () => {
      const spec = createMinimalSpec();
      (spec.infrastructure as any).provider = undefined;
      const result = validateDeploymentSpec(spec);
      expect(result.errors.some(e => e.path === 'infrastructure.provider')).to.be.true;
    });

    it('fails when provider is aws but aws config is missing', () => {
      const spec = createMinimalSpec();
      spec.infrastructure.provider = 'aws';
      spec.infrastructure.aws = undefined;
      const result = validateDeploymentSpec(spec);
      expect(result.errors.some(e => e.code === 'E003_MISSING_PROVIDER_CONFIG')).to.be.true;
    });

    it('fails when chain IDs are missing', () => {
      const spec = createMinimalSpec();
      (spec.network as any).l1ChainId = undefined;
      const result = validateDeploymentSpec(spec);
      expect(result.errors.some(e => e.path === 'network')).to.be.true;
    });

    it('fails when deployer address is missing', () => {
      const spec = createMinimalSpec();
      spec.accounts.deployer.address = '';
      const result = validateDeploymentSpec(spec);
      expect(result.errors.some(e => e.path === 'accounts.deployer.address')).to.be.true;
    });

    it('fails on invalid Ethereum address format', () => {
      const spec = createMinimalSpec();
      spec.accounts.deployer.address = '0xinvalid';
      const result = validateDeploymentSpec(spec);
      expect(result.errors.some(e => e.code === 'E004_INVALID_ADDRESS')).to.be.true;
    });

    it('warns when mainnet env uses non-mainnet dogecoin network', () => {
      const spec = createMinimalSpec();
      spec.metadata.environment = 'mainnet';
      spec.dogecoin.network = 'testnet';
      const result = validateDeploymentSpec(spec);
      expect(result.warnings.some(w => w.path === 'dogecoin.network')).to.be.true;
    });

    it('fails when signing method is missing', () => {
      const spec = createMinimalSpec();
      (spec.signing as any).method = undefined;
      const result = validateDeploymentSpec(spec);
      expect(result.errors.some(e => e.path === 'signing.method')).to.be.true;
    });

    it('fails when cubesigner method has no roles', () => {
      const spec = createMinimalSpec();
      spec.signing = { cubesigner: { roles: [] }, method: 'cubesigner' };
      const result = validateDeploymentSpec(spec);
      expect(result.errors.some(e => e.code === 'E003_MISSING_PROVIDER_CONFIG')).to.be.true;
    });

    it('fails when attestation threshold exceeds key count', () => {
      const spec = createMinimalSpec();
      spec.bridge.thresholds.attestation = 10;
      spec.bridge.keyCounts.attestation = 3;
      const result = validateDeploymentSpec(spec);
      expect(result.errors.some(e => e.code === 'E005_INVALID_THRESHOLD')).to.be.true;
    });

    it('validates image pullPolicy', () => {
      const spec = createMinimalSpec();
      spec.images = { defaults: { pullPolicy: 'InvalidPolicy' as any } };
      const result = validateDeploymentSpec(spec);
      expect(result.errors.some(e => e.code === 'E006_INVALID_IMAGE_CONFIG')).to.be.true;
    });

    it('validates image tag format', () => {
      const spec = createMinimalSpec();
      spec.images = { services: { l2Sequencer: { tag: 'invalid tag with spaces' } } };
      const result = validateDeploymentSpec(spec);
      expect(result.errors.some(e => e.code === 'E006_INVALID_IMAGE_CONFIG')).to.be.true;
    });

    it('allows $ENV: refs in image tags without format validation', () => {
      const spec = createMinimalSpec();
      spec.images = { services: { l2Sequencer: { tag: '$ENV:IMAGE_TAG' } } };
      const result = validateDeploymentSpec(spec);
      expect(result.errors.filter(e => e.path?.includes('l2Sequencer'))).to.have.lengthOf(0);
    });

    it('warns when tag is set without repository', () => {
      const spec = createMinimalSpec();
      spec.images = { services: { l2Sequencer: { tag: 'v1.0.0' } } };
      const result = validateDeploymentSpec(spec);
      expect(result.warnings.some(w => w.path?.includes('l2Sequencer'))).to.be.true;
    });
  });

  describe('generateConfigToml', () => {
    it('generates valid TOML with all required sections', () => {
      const spec = createMinimalSpec();
      const output = generateConfigToml(spec);

      expect(output).to.include('CHAIN_ID_L1');
      expect(output).to.include('CHAIN_ID_L2');
      expect(output).to.include('DEPLOYER_ADDR');
      expect(output).to.include('L1_RPC_ENDPOINT');
    });

    it('includes general section with network config', () => {
      const spec = createMinimalSpec();
      const output = generateConfigToml(spec);

      // TOML integers are formatted with underscores by @iarna/toml for large numbers
      expect(output).to.include('CHAIN_ID_L1');
      expect(output).to.include('CHAIN_ID_L2');
      expect(output).to.include('L1_RPC_ENDPOINT');
      expect(output).to.include('http://l1-rpc:8545');
    });

    it('includes database connection strings', () => {
      const spec = createMinimalSpec();
      const output = generateConfigToml(spec);

      expect(output).to.include('ADMIN_SYSTEM_BACKEND_DB_CONNECTION_STRING');
      expect(output).to.include('postgres://');
      expect(output).to.include('db.local:5432');
    });

    it('URL-encodes passwords in connection strings', () => {
      const spec = createMinimalSpec();
      spec.database.credentials.rollupNodePassword = 'p@ss/word';
      const output = generateConfigToml(spec);

      expect(output).to.include('p%40ss%2Fword');
    });

    it('preserves $ENV: references in connection strings', () => {
      const spec = createMinimalSpec();
      spec.database.credentials.rollupNodePassword = '$ENV:DB_PASSWORD';
      const output = generateConfigToml(spec);

      expect(output).to.include('$ENV:DB_PASSWORD');
    });

    it('includes rollup configuration', () => {
      const spec = createMinimalSpec();
      const output = generateConfigToml(spec);

      expect(output).to.include('MAX_BATCH_IN_BUNDLE');
      expect(output).to.include('FINALIZE_BATCH_DEADLINE_SEC');
    });

    it('includes ingress hosts', () => {
      const spec = createMinimalSpec();
      const output = generateConfigToml(spec);

      expect(output).to.include('FRONTEND_HOST');
      expect(output).to.include('app.example.com');
    });

    it('includes optional ingress hosts when present', () => {
      const spec = createMinimalSpec();
      spec.frontend.hosts.rpcGatewayWs = 'ws.example.com';
      spec.frontend.hosts.blockscoutBackend = 'blockscout-be.example.com';
      const output = generateConfigToml(spec);

      expect(output).to.include('RPC_GATEWAY_WS_HOST');
      expect(output).to.include('ws.example.com');
      expect(output).to.include('BLOCKSCOUT_BACKEND_HOST');
    });

    it('includes verifier digests when present', () => {
      const spec = createMinimalSpec();
      spec.rollup.verifierDigests = { digest1: '0xabc', digest2: '0xdef' };
      const output = generateConfigToml(spec);

      expect(output).to.include('VERIFIER_DIGEST_1');
      expect(output).to.include('0xabc');
    });

    it('includes contract verification when present', () => {
      const spec = createMinimalSpec();
      spec.contracts.verification = {
        l1ExplorerUri: 'https://etherscan.io',
        l1VerifierType: 'etherscan',
        l2ExplorerUri: 'https://scrollscan.com',
        l2VerifierType: 'blockscout',
      };
      const output = generateConfigToml(spec);

      expect(output).to.include('VERIFIER_TYPE_L1');
      expect(output).to.include('etherscan');
    });

    it('uses VPC host/port when available', () => {
      const spec = createMinimalSpec();
      spec.database.admin!.vpcHost = 'vpc-db.internal';
      spec.database.admin!.vpcPort = 5433;
      const output = generateConfigToml(spec);

      expect(output).to.include('vpc-db.internal:5433');
    });
  });

  describe('generateDogeConfigToml', () => {
    it('includes dogecoin network and RPC config', () => {
      const spec = createMinimalSpec();
      const output = generateDogeConfigToml(spec);

      expect(output).to.include('testnet');
      expect(output).to.include('http://dogecoin-rpc:22555');
      expect(output).to.include('rpcuser');
    });

    it('includes wallet path', () => {
      const spec = createMinimalSpec();
      const output = generateDogeConfigToml(spec);

      expect(output).to.include('/data/wallet.dat');
    });

    it('includes celestia DA config', () => {
      const spec = createMinimalSpec();
      const output = generateDogeConfigToml(spec);

      expect(output).to.include('celestiaIndexerStartBlock');
      expect(output).to.include('0x0102030405060708');
      expect(output).to.include('http://celestia-rpc:26657');
    });

    it('includes blockbook config when present', () => {
      const spec = createMinimalSpec();
      spec.dogecoin.blockbook = { apiKey: 'key123', apiUrl: 'https://blockbook.example.com' };
      const output = generateDogeConfigToml(spec);

      expect(output).to.include('blockbookAPIUrl');
      expect(output).to.include('https://blockbook.example.com');
      expect(output).to.include('apiKey');
    });

    it('includes cubesigner config when signing method is cubesigner', () => {
      const spec = createMinimalSpec();
      spec.signing = {
        cubesigner: {
          roles: [{
            keys: [{ keyId: 'k1', keyType: 'secp256k1', materialId: 'm1', publicKey: '0xpub1' }],
            name: 'role1',
            roleId: 'r1',
          }],
        },
        method: 'cubesigner',
      };
      const output = generateDogeConfigToml(spec);

      expect(output).to.include('cubesigner');
      expect(output).to.include('role1');
    });

    it('includes aws-kms config when signing method is aws-kms', () => {
      const spec = createMinimalSpec();
      spec.signing = {
        awsKms: { accountId: '123456789', networkAlias: 'testnet', region: 'us-east-1', suffixes: ['suf1', 'suf2'] },
        method: 'aws-kms',
      };
      const output = generateDogeConfigToml(spec);

      expect(output).to.include('awsSigner');
      expect(output).to.include('us-east-1');
      expect(output).to.include('suf1,suf2');
    });

    it('includes local signer config', () => {
      const spec = createMinimalSpec();
      spec.signing = {
        local: { signers: [{ index: 0, port: 8080 }] },
        method: 'local',
      };
      const output = generateDogeConfigToml(spec);

      expect(output).to.include('localSigners');
    });

    it('includes TSO service URL when present', () => {
      const spec = createMinimalSpec();
      spec.signing.tsoServiceUrl = 'http://tso:9090';
      const output = generateDogeConfigToml(spec);

      expect(output).to.include('http://tso:9090');
    });

    it('sets deploymentType based on provider', () => {
      const localSpec = createMinimalSpec();
      localSpec.infrastructure.provider = 'local';
      expect(generateDogeConfigToml(localSpec)).to.include('local');

      const awsSpec = createMinimalSpec();
      awsSpec.infrastructure.provider = 'aws';
      awsSpec.infrastructure.aws = { accountId: '1', eksClusterName: 'c', region: 'r' };
      expect(generateDogeConfigToml(awsSpec)).to.include('aws');
    });

    it('includes test config when present', () => {
      const spec = createMinimalSpec({ test: { mockFinalizeEnabled: true, mockFinalizeTimeoutSec: 30 } });
      const output = generateDogeConfigToml(spec);

      expect(output).to.include('mockFinalizeEnabled');
    });
  });

  describe('generateSetupDefaultsToml', () => {
    it('includes bridge key counts and thresholds', () => {
      const spec = createMinimalSpec();
      const output = generateSetupDefaultsToml(spec);

      expect(output).to.include('attestation_key_count');
      expect(output).to.include('attestation_threshold');
      expect(output).to.include('correctness_key_count');
      expect(output).to.include('recovery_key_count');
    });

    it('includes seed string', () => {
      const spec = createMinimalSpec();
      const output = generateSetupDefaultsToml(spec);

      expect(output).to.include('seed_string');
      expect(output).to.include('test-seed-string');
    });

    it('includes dogecoin RPC config', () => {
      const spec = createMinimalSpec();
      const output = generateSetupDefaultsToml(spec);

      expect(output).to.include('dogecoin_rpc_url');
      expect(output).to.include('http://dogecoin-rpc:22555');
    });

    it('includes target amounts', () => {
      const spec = createMinimalSpec();
      const output = generateSetupDefaultsToml(spec);

      expect(output).to.include('bridge_target_amount');
      expect(output).to.include('fee_wallet_target_amount');
      expect(output).to.include('sequencer_target_amount');
    });

    it('includes deployer address as deposit recipient', () => {
      const spec = createMinimalSpec();
      const output = generateSetupDefaultsToml(spec);

      expect(output).to.include('deposit_eth_recipient_address_hex');
      expect(output).to.include('0x1234567890abcdef1234567890abcdef12345678');
    });

    it('includes attestation pubkeys from cubesigner roles', () => {
      const spec = createMinimalSpec();
      spec.signing = {
        cubesigner: {
          roles: [
            { keys: [{ keyId: 'k1', keyType: 'secp256k1', materialId: 'm1', publicKey: '0xabc123' }], name: 'r1', roleId: 'id1' },
            { keys: [{ keyId: 'k2', keyType: 'secp256k1', materialId: 'm2', publicKey: '0xdef456' }], name: 'r2', roleId: 'id2' },
          ],
        },
        method: 'cubesigner',
      };
      const output = generateSetupDefaultsToml(spec);

      expect(output).to.include('attestation_pubkeys');
      // 0x prefix should be stripped
      expect(output).to.include('abc123');
      expect(output).to.include('def456');
    });
  });

  describe('generateAllConfigs', () => {
    it('returns all three config files', () => {
      const spec = createMinimalSpec();
      const configs = generateAllConfigs(spec);

      expect(configs).to.have.property('config.toml');
      expect(configs).to.have.property('doge-config.toml');
      expect(configs).to.have.property('setup_defaults.toml');

      expect(configs['config.toml']).to.be.a('string').and.not.be.empty;
      expect(configs['doge-config.toml']).to.be.a('string').and.not.be.empty;
      expect(configs['setup_defaults.toml']).to.be.a('string').and.not.be.empty;
    });
  });
});
