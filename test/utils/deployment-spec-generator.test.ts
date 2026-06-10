/* eslint-disable @typescript-eslint/no-explicit-any -- Test mocking */
import * as toml from '@iarna/toml';
import { expect } from 'chai';
import * as yaml from 'js-yaml';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import sinon from 'sinon';

import type { DeploymentSpec } from '../../src/types/deployment-spec.js';

import {
  generateAllConfigs,
  generateConfigToml,
  generateDogeConfigToml,
  generateProtocolSeedToml,
  generateSetupDefaultsToml,
  hasEnvRef,
  loadDeploymentSpec,
  normalizeDeploymentSpec,
  resolveInlineEnvRefs,
  validateDeploymentSpec,
  writeGeneratedConfigs,
} from '../../src/utils/deployment-spec-generator.js';
import { generateValuesFiles } from '../../src/utils/values-generator.js';

const TEST_PRIVATE_KEYS = {
  COMMIT_PK: '0x2222222222222222222222222222222222222222222222222222222222222222',
  DEPLOYER_PK: '0x1111111111111111111111111111111111111111111111111111111111111111',
  FINALIZE_PK: '0x3333333333333333333333333333333333333333333333333333333333333333',
  GAS_L1_PK: '0x4444444444444444444444444444444444444444444444444444444444444444',
  GAS_L2_PK: '0x5555555555555555555555555555555555555555555555555555555555555555',
} as const

/**
 * Minimal valid DeploymentSpec fixture for testing generators.
 * Contains all required fields with sensible defaults.
 */
function createMinimalSpec(overrides?: Partial<DeploymentSpec>): DeploymentSpec {
  return {
    accounts: {
      deployer: { address: '0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A', privateKey: '$ENV:DEPLOYER_PK' },
      l1CommitSender: { address: '0x1563915e194D8CfBA1943570603F7606A3115508', privateKey: '$ENV:COMMIT_PK' },
      l1FinalizeSender: { address: '0x5CbDd86a2FA8Dc4bDdd8a8f69dBa48572EeC07FB', privateKey: '$ENV:FINALIZE_PK' },
      l1GasOracleSender: { address: '0x7564105E977516C53bE337314c7E53838967bDaC', privateKey: '$ENV:GAS_L1_PK' },
      l2GasOracleSender: { address: '0xe1fAE9b4fAB2F5726677ECfA912d96b0B683e6a9', privateKey: '$ENV:GAS_L2_PK' },
      owner: { address: '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' },
    },
    bridge: {
      confirmationsRequired: 6,
      feeRateSatsPerKvb: 100_000,
      feeRecipient: '0x0000000000000000000000000000000000000001',
      fees: { depositFeeSats: '0', minWithdrawalAmountWei: '1000000000000000', withdrawalFeeWei: '0' },
      keyCounts: { attestation: 3, recovery: 1 },
      seedString: 'test-seed-string',
      targetAmountsSats: { bridge: 10_000_000, feeWallet: 5_000_000, sequencer: 8_000_000 },
      thresholds: { attestation: 2, recovery: 1 },
      timelock: 86_400,
    },
    contracts: {
      deploymentSalt: '0xabcdef',
      gasOracle: { blobScalar: 1, penaltyFactor: 1, penaltyThreshold: 100, scalar: 1 },
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
    },
    dogecoin: {
      clusterRpc: { password: 'cluster-rpc-pass', username: 'cluster-rpc-user' },
      externalRpc: { password: 'external-rpc-pass', url: 'https://dogecoin-external.example.com', username: 'external-rpc-user' },
      network: 'testnet',
      walletPath: '/data/wallet.dat',
    },
    ethereumDa: {
      beaconRpcUrl: 'https://ethereum-sepolia-beacon-api.publicnode.com',
      chain: 'sepolia',
      finalizationDepth: 64,
      l1RpcUrl: 'https://sepolia.drpc.org',
      minFinality: 'finalized',
    },
    frontend: {
      baseDomain: 'example.com',
      externalUrls: {
        adminDashboard: 'https://admin.example.com',
        bridgeApi: 'https://bridge-api.example.com',
        grafana: 'https://grafana.example.com',
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
      baseFeePerGasWei: 1_000_000_000,
      deployerInitialBalanceWei: '1000000000000000000',
      maxEthSupplyWei: '100000000000000000000000000',
    },
    infrastructure: { bootnodeCount: 1, provider: 'local', sequencerCount: 1 },
    metadata: { environment: 'testnet', name: 'test-deployment' },
    network: {
      l1ChainId: 111_111,
      l1ChainName: 'DOGE',
      l2ChainId: 534_351,
      l2ChainName: 'DogeOS Testnet',
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
    signing: { cubesigner: { roles: [] }, local: { signers: [] } },
    version: '1.0',
    ...overrides,
  } as DeploymentSpec;
}

describe('deployment-spec-generator', () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
    Object.assign(process.env, TEST_PRIVATE_KEYS);
  });

  afterEach(() => {
    sinon.restore();
    process.env = originalEnv;
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

    it('returns true for lowercase env refs', () => {
      // Pattern now uses \w+ which matches lowercase letters too
      expect(hasEnvRef('$ENV:lowercase')).to.be.true;
    });

    it('returns true for mixed case env refs', () => {
      expect(hasEnvRef('$ENV:My_Var_123')).to.be.true;
    });
  });

  describe('normalizeDeploymentSpec', () => {
    it('derives account addresses from literal private keys', () => {
      const spec = createMinimalSpec();
      spec.accounts.deployer = {
        privateKey: '0x1111111111111111111111111111111111111111111111111111111111111111',
      };

      const normalized = normalizeDeploymentSpec(spec);

      expect(normalized.accounts.deployer?.address).to.equal('0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A');
      expect(normalized.accounts.deployer?.privateKey).to.equal(
        '0x1111111111111111111111111111111111111111111111111111111111111111'
      );
    });

    it('derives account addresses from exact $ENV private key references without expanding secrets', () => {
      const originalEnv = process.env.DEPLOYER_PK;
      process.env.DEPLOYER_PK = '0x1111111111111111111111111111111111111111111111111111111111111111';
      const spec = createMinimalSpec();
      spec.accounts.deployer = {
        privateKey: '$ENV:DEPLOYER_PK',
      };

      const normalized = normalizeDeploymentSpec(spec);

      expect(normalized.accounts.deployer?.address).to.equal('0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A');
      expect(normalized.accounts.deployer?.privateKey).to.equal('$ENV:DEPLOYER_PK');
      if (originalEnv === undefined) {
        delete process.env.DEPLOYER_PK;
      } else {
        process.env.DEPLOYER_PK = originalEnv;
      }
    });

    it('defaults the execution client backend to l2geth', () => {
      const spec = createMinimalSpec();
      delete spec.executionClient;

      const normalized = normalizeDeploymentSpec(spec);

      expect(normalized.executionClient?.backend).to.equal('l2geth');
    });

    it('derives frontend hosts and external URLs from baseDomain', () => {
      const spec = createMinimalSpec();
      (spec.frontend as any) = {
        baseDomain: 'testnet.dogeos.io',
        protocol: 'https',
        subdomains: {
          blockbook: 'blockbook',
          blockscout: 'blockscout',
          bridgeHistoryApi: 'bridge-history-api',
          frontend: 'portal',
          rollupExplorerApi: 'rollup-explorer-backend',
          rpcGateway: 'rpc',
        },
      };

      const normalized = normalizeDeploymentSpec(spec);

      expect(normalized.frontend.hosts.frontend).to.equal('portal.testnet.dogeos.io');
      expect(normalized.frontend.hosts.blockscout).to.equal('blockscout.testnet.dogeos.io');
      expect(normalized.frontend.externalUrls.l2Explorer).to.equal('https://blockscout.testnet.dogeos.io');
      expect(normalized.frontend.externalUrls.bridgeApi).to.equal('https://bridge-history-api.testnet.dogeos.io/api');
      expect(normalized.frontend.externalUrls.rollupScanApi).to.equal('https://rollup-explorer-backend.testnet.dogeos.io/api');
    });

    it('fills contract verification explorer URLs from frontend URLs', () => {
      const spec = createMinimalSpec();
      (spec.frontend as any) = {
        baseDomain: 'testnet.dogeos.io',
        protocol: 'https',
      };
      spec.contracts.verification = {
        l1VerifierType: 'blockscout',
        l2VerifierType: 'blockscout',
      } as any;

      const normalized = normalizeDeploymentSpec(spec);

      expect(normalized.contracts.verification?.l1ExplorerUri).to.equal('https://blockbook.testnet.dogeos.io');
      expect(normalized.contracts.verification?.l2ExplorerUri).to.equal('https://blockscout.testnet.dogeos.io');
    });

    it('preserves explicit frontend overrides', () => {
      const spec = createMinimalSpec();
      spec.frontend.externalUrls.l2Explorer = 'https://custom-explorer.example.com';

      const normalized = normalizeDeploymentSpec(spec);

      expect(normalized.frontend.externalUrls.l2Explorer).to.equal('https://custom-explorer.example.com');
      expect(normalized.frontend.hosts.blockscout).to.equal('blockscout.example.com');
    });
  });

  describe('validateDeploymentSpec', () => {
    it('passes validation for a complete spec', () => {
      const spec = createMinimalSpec();
      const result = validateDeploymentSpec(spec);
      expect(result.valid).to.be.true;
      expect(result.errors).to.have.lengthOf(0);
    });

    it('fails on unsupported execution client backend', () => {
      const spec = createMinimalSpec({ executionClient: { backend: 'nethermind' as any } });
      const result = validateDeploymentSpec(spec);
      expect(result.valid).to.be.false;
      expect(result.errors.some(e => e.path === 'executionClient.backend')).to.be.true;
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

    it('allows deployer address to be omitted when it can be derived from private key', () => {
      const spec = createMinimalSpec();
      spec.accounts.deployer!.address = '';
      const result = validateDeploymentSpec(spec);
      expect(result.errors.some(e => e.path === 'accounts.deployer.address')).to.be.false;
    });

    it('fails when account address does not match the provided private key', () => {
      const spec = createMinimalSpec();
      spec.accounts.deployer = {
        address: '0x0000000000000000000000000000000000000001',
        privateKey: '0x1111111111111111111111111111111111111111111111111111111111111111',
      };

      const result = validateDeploymentSpec(spec);

      expect(result.errors.some(e => e.code === 'E009_ACCOUNT_ADDRESS_MISMATCH')).to.be.true;
    });

    it('warns when account address is omitted and the $ENV private key is unavailable', () => {
      const originalEnv = process.env.MISSING_DEPLOYER_PK;
      delete process.env.MISSING_DEPLOYER_PK;
      const spec = createMinimalSpec();
      spec.accounts.deployer = {
        privateKey: '$ENV:MISSING_DEPLOYER_PK',
      };

      const result = validateDeploymentSpec(spec);

      expect(result.valid).to.be.true;
      expect(result.warnings.some(e => e.path === 'accounts.deployer.address')).to.be.true;
      if (originalEnv !== undefined) {
        process.env.MISSING_DEPLOYER_PK = originalEnv;
      }
    });

    it('fails on invalid Ethereum address format', () => {
      const spec = createMinimalSpec();
      spec.accounts.owner.address = '0xinvalid';
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

    it('fails when the Dogecoin indexer starts at or after the L1 genesis block', () => {
      const spec = createMinimalSpec();
      spec.dogecoin.indexerStartHeight = 8_208_200;
      spec.dogecoin.l1GenesisBlock = 8_208_200;

      const result = validateDeploymentSpec(spec);

      expect(result.valid).to.be.false;
      expect(result.errors.some(error =>
        error.code === 'E011_INVALID_DOGECOIN_HEIGHT' &&
        error.path === 'dogecoin.indexerStartHeight'
      )).to.be.true;
    });

    it('fails when enabled Ethereum DA S3 archive is missing publicBaseUrl', () => {
      const spec = createMinimalSpec();
      spec.ethereumDa!.blobArchive = {
        s3: {
          bucket: 'dogeos-da',
          enabled: true,
          region: 'us-east-1',
        },
      };

      const result = validateDeploymentSpec(spec);

      expect(result.valid).to.be.false;
      expect(result.errors.some(error =>
        error.code === 'E002_MISSING_REQUIRED_FIELD' &&
        error.path === 'ethereumDa.blobArchive.s3.publicBaseUrl'
      )).to.be.true;
    });

    it('fails when Ethereum DA inbox worker start block is negative', () => {
      const spec = createMinimalSpec();
      spec.ethereumDa!.inboxWorker = { startBlock: -1 };

      const result = validateDeploymentSpec(spec);

      expect(result.valid).to.be.false;
      expect(result.errors.some(error =>
        error.code === 'E012_INVALID_ETHEREUM_DA_CONFIG' &&
        error.path === 'ethereumDa.inboxWorker.startBlock'
      )).to.be.true;
    });

    it('fails when l1 chain ID does not match dogecoin network', () => {
      const spec = createMinimalSpec();
      spec.dogecoin.network = 'mainnet';
      spec.network.l1ChainId = 111_111;

      const result = validateDeploymentSpec(spec);

      expect(result.valid).to.be.false;
      expect(result.errors.some(error =>
        error.code === 'E010_DOGECOIN_NETWORK_MISMATCH' &&
        error.path === 'network.l1ChainId'
      )).to.be.true;
    });

    it('warns when cubesigner TEE role is not set yet', () => {
      const spec = createMinimalSpec();
      spec.signing = { cubesigner: { roles: [] }, local: { signers: [] } };
      const result = validateDeploymentSpec(spec);
      expect(result.valid).to.be.true;
      expect(result.warnings.some(w => w.path === 'signing.cubesigner.roles')).to.be.true;
    });

    it('fails when ECS Express dummy signer account or region is missing', () => {
      const spec = createMinimalSpec();
      spec.signing = {
        awsKms: {},
        cubesigner: { roles: [] },
      };

      const result = validateDeploymentSpec(spec);

      expect(result.valid).to.be.false;
      expect(result.errors.some(error => error.path === 'signing.awsKms.accountId')).to.be.true;
      expect(result.errors.some(error => error.path === 'signing.awsKms.region')).to.be.true;
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

    it('generates account addresses from $ENV private keys and writes expanded secrets', () => {
      const originalEnv = process.env.DEPLOYER_PK;
      process.env.DEPLOYER_PK = '0x1111111111111111111111111111111111111111111111111111111111111111';
      const spec = createMinimalSpec();
      spec.accounts.deployer = {
        privateKey: '$ENV:DEPLOYER_PK',
      };

      const output = generateConfigToml(spec);

      expect(output).to.include('DEPLOYER_ADDR = "0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A"');
      expect(output).to.include('DEPLOYER_PRIVATE_KEY = "0x1111111111111111111111111111111111111111111111111111111111111111"');
      expect(output).not.to.include('$ENV:DEPLOYER_PK');
      if (originalEnv === undefined) {
        delete process.env.DEPLOYER_PK;
      } else {
        process.env.DEPLOYER_PK = originalEnv;
      }
    });

    it('includes general section with network config', () => {
      const spec = createMinimalSpec();
      const output = generateConfigToml(spec);

      // TOML integers are formatted with underscores by @iarna/toml for large numbers
      expect(output).to.include('CHAIN_ID_L1');
      expect(output).to.include('CHAIN_ID_L2');
      expect(output).to.include('L1_RPC_ENDPOINT');
      expect(output).to.include('http://l1-interface:8545');
      expect(output).to.include('ws://l1-devnet:8546');
      expect(output).to.include('http://l2-rpc:8545');
      expect(output).not.to.include('BEACON_RPC_ENDPOINT');
      expect(output).not.to.include('[dogecoin]');
      expect(output).not.to.include('[ethereumDa]');
    });

    it('includes database connection strings', () => {
      const spec = createMinimalSpec();
      const output = generateConfigToml(spec);

      expect(output).to.include('ADMIN_SYSTEM_BACKEND_DB_CONNECTION_STRING');
      expect(output).to.include('postgres://');
      expect(output).to.include('db.local:5432');
      expect(output).to.include('/admin_system?sslmode=disable');
      expect(output).to.include('/rollup_node?sslmode=disable');
    });

    it('URL-encodes passwords in connection strings', () => {
      const spec = createMinimalSpec();
      spec.database.credentials!.rollupNodePassword = 'p@ss/word';
      const output = generateConfigToml(spec);

      expect(output).to.include('p%40ss%2Fword');
    });

    it('resolves $ENV references in connection strings', () => {
      const spec = createMinimalSpec();
      spec.database.credentials!.rollupNodePassword = '$ENV:DB_PASSWORD';
      process.env.DB_PASSWORD = 'resolved-db-password';
      const output = generateConfigToml(spec);

      expect(output).to.include('resolved-db-password');
      expect(output).not.to.include('$ENV:DB_PASSWORD');
    });

    it('includes rollup configuration', () => {
      const spec = createMinimalSpec();
      const output = generateConfigToml(spec);

      expect(output).to.include('MAX_BATCH_IN_BUNDLE');
      expect(output).to.include('FINALIZE_BATCH_DEADLINE_SEC');
    });

    it('uses a fixed L1 fee vault address instead of reading it from the spec', () => {
      const spec = createMinimalSpec() as any;
      spec.contracts.l1FeeVaultAddr = '0x2222222222222222222222222222222222222222';
      const output = generateConfigToml(spec);

      expect(output).to.include('L1_FEE_VAULT_ADDR = "0x1111111111111111111111111111111111111111"');
      expect(output).not.to.include('L1_FEE_VAULT_ADDR = "0x2222222222222222222222222222222222222222"');
    });

    it('includes admin dashboard and Grafana frontend URIs required by contract scripts', () => {
      const spec = createMinimalSpec();
      const output = generateConfigToml(spec);

      expect(output).to.include('ADMIN_SYSTEM_DASHBOARD_URI = "https://admin.example.com"');
      expect(output).to.include('GRAFANA_URI = "https://grafana.example.com"');
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

    it('generates config from derived frontend fields', () => {
      const spec = createMinimalSpec();
      (spec.frontend as any) = {
        baseDomain: 'testnet.dogeos.io',
        protocol: 'https',
      };
      spec.contracts.verification = {
        l1VerifierType: 'blockscout',
        l2VerifierType: 'blockscout',
      } as any;

      const output = generateConfigToml(spec);

      expect(output).to.include('FRONTEND_HOST = "portal.testnet.dogeos.io"');
      expect(output).to.include('ADMIN_SYSTEM_DASHBOARD_HOST = "admin-system-dashboard.testnet.dogeos.io"');
      expect(output).to.include('BRIDGE_HISTORY_API_HOST = "bridge-history-api.testnet.dogeos.io"');
      expect(output).to.include('COORDINATOR_API_HOST = "coordinator-api.testnet.dogeos.io"');
      expect(output).to.include('ROLLUP_EXPLORER_API_HOST = "rollup-explorer-backend.testnet.dogeos.io"');
      expect(output).to.include('BRIDGE_API_URI = "https://bridge-history-api.testnet.dogeos.io/api"');
      expect(output).to.include('ROLLUPSCAN_API_URI = "https://rollup-explorer-backend.testnet.dogeos.io/api"');
      expect(output).to.include('EXTERNAL_EXPLORER_URI_L2 = "https://blockscout.testnet.dogeos.io"');
      expect(output).to.include('EXPLORER_URI_L2 = "https://blockscout.testnet.dogeos.io"');
    });

    it('uses VPC host/port when available', () => {
      const spec = createMinimalSpec();
      spec.database.admin!.vpcHost = 'vpc-db.internal';
      spec.database.admin!.vpcPort = 5433;
      const output = generateConfigToml(spec);

      expect(output).to.include('vpc-db.internal:5433');
    });

    it('includes sequencer signer metadata when present in spec', () => {
      const spec = createMinimalSpec();
      spec.infrastructure.sequencers = [
        {
          enodeUrl: 'enode://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa@l2-sequencer-0:30303',
          index: 0,
          signerAddress: '0x1234567890123456789012345678901234567890',
        },
        {
          enodeUrl: 'enode://bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb@l2-sequencer-1:30303',
          index: 1,
          signerAddress: '0x2234567890123456789012345678901234567890',
        },
      ];
      const output = generateConfigToml(spec);

      expect(output).to.include('[sequencer]');
      expect(output).to.include('L2GETH_SIGNER_ADDRESS = "0x1234567890123456789012345678901234567890"');
      expect(output).to.include('[sequencer.sequencer-1]');
      expect(output).to.include('L2GETH_SIGNER_ADDRESS = "0x2234567890123456789012345678901234567890"');
      expect(output).to.include('l2-sequencer-0:30303');
      expect(output).to.include('l2-sequencer-1:30303');
    });
  });

  describe('generateDogeConfigToml', () => {
    it('includes RPC config and the Dogecoin network source', () => {
      const spec = createMinimalSpec();
      const output = generateDogeConfigToml(spec);

      const parsed = toml.parse(output) as any;
      expect(parsed.network).to.equal('testnet');
      expect(output).to.include('https://dogecoin-external.example.com');
      expect(output).to.include('external-rpc-user');
      expect(output).to.include('dogecoinClusterRpc');
      expect(output).to.include('cluster-rpc-user');
    });

    it('includes wallet path', () => {
      const spec = createMinimalSpec();
      const output = generateDogeConfigToml(spec);

      expect(output).to.include('/data/wallet.dat');
    });

    it('includes L1 genesis block derived from the Dogecoin indexer start height', () => {
      const spec = createMinimalSpec();
      spec.dogecoin.indexerStartHeight = 8_208_199;
      const parsed = toml.parse(generateDogeConfigToml(spec)) as any;

      expect(parsed.defaults.dogecoinIndexerStartHeight).to.equal('8208199');
      expect(parsed.defaults.l1GenesisBlock).to.equal('8208200');
    });

    it('preserves explicit L1 genesis block from the spec', () => {
      const spec = createMinimalSpec();
      spec.dogecoin.indexerStartHeight = 8_200_000;
      spec.dogecoin.l1GenesisBlock = 8_208_200;
      const parsed = toml.parse(generateDogeConfigToml(spec)) as any;

      expect(parsed.defaults.dogecoinIndexerStartHeight).to.equal('8200000');
      expect(parsed.defaults.l1GenesisBlock).to.equal('8208200');
    });

    it('includes Ethereum DA config', () => {
      const spec = createMinimalSpec();
      const output = generateDogeConfigToml(spec);

      expect(output).to.include('[ethereumDa]');
      expect(output).to.include('chain = "sepolia"');
      expect(output).to.include('submitterRpcUrl = "https://sepolia.drpc.org"');
      expect(output).to.include('beaconRpcUrl = "https://ethereum-sepolia-beacon-api.publicnode.com"');
      expect(output).not.to.include('submitterPrivateKey');
      expect(output).not.to.include('eth-da-indexer.sqlite');
      expect(output).not.to.include('eth-da-artifacts');
      expect(output).not.to.include('celestiaIndexerStartBlock');
    });

    it('includes Ethereum DA S3 archive config', () => {
      const spec = createMinimalSpec();
      spec.ethereumDa!.blobArchive = {
        s3: {
          bucket: 'dogeos-da',
          enabled: true,
          maxRetries: 5,
          publicBaseUrl: 'https://dogeos-da.s3.us-east-1.amazonaws.com/',
          region: 'us-east-1',
          timeoutMs: 15_000,
          treatForbiddenAsMissing: false,
        },
      };

      const parsed = toml.parse(generateDogeConfigToml(spec)) as any;

      expect(parsed.ethereumDa.blobArchive.s3.enabled).to.equal(true);
      expect(parsed.ethereumDa.blobArchive.s3.bucket).to.equal('dogeos-da');
      expect(parsed.ethereumDa.blobArchive.s3.region).to.equal('us-east-1');
      expect(parsed.ethereumDa.blobArchive.s3.publicBaseUrl).to.equal('https://dogeos-da.s3.us-east-1.amazonaws.com/');
      expect(parsed.ethereumDa.blobArchive.s3.timeoutMs).to.equal(15_000);
      expect(parsed.ethereumDa.blobArchive.s3.treatForbiddenAsMissing).to.equal(false);
    });

    it('includes blockbook config when present', () => {
      const spec = createMinimalSpec();
      spec.dogecoin.blockbook = { apiKey: 'key123', apiUrl: 'https://blockbook.example.com' };
      const output = generateDogeConfigToml(spec);

      expect(output).to.include('blockbookAPIUrl');
      expect(output).to.include('https://blockbook.example.com');
      expect(output).to.include('apiKey');
    });

    it('includes cubesigner TEE config when present', () => {
      const spec = createMinimalSpec();
      spec.signing = {
        cubesigner: {
          roles: [{
            keys: [{ keyId: 'k1', keyType: 'secp256k1', materialId: 'm1', publicKey: '0xpub1' }],
            name: 'role1',
            roleId: 'r1',
          }],
        },
      };
      const output = generateDogeConfigToml(spec);

      expect(output).to.include('cubesigner');
      expect(output).to.include('role1');
    });

    it('includes explicit aws-kms attestation signer config when present', () => {
      const spec = createMinimalSpec();
      spec.signing = {
        awsKms: { accountId: '123456789', networkAlias: 'testnet', region: 'us-east-1' },
        cubesigner: { roles: [] },
      };
      const output = generateDogeConfigToml(spec);

      expect(output).to.include('awsSigner');
      expect(output).to.include('us-east-1');
      expect(output).to.include('ecsClusterName = "default"');
      expect(output).to.include('dummySigner');
      expect(output).to.include('provider = "aws"');
      expect(output).not.to.include('suffixes');
    });

    it('does not infer AWS dummy signer config from infrastructure.aws alone', () => {
      const spec = createMinimalSpec();
      spec.infrastructure = {
        aws: { accountId: '123456789012', eksClusterName: 'dogeos-testnet-cluster', region: 'us-west-2' },
        bootnodeCount: 1,
        provider: 'aws',
        sequencerCount: 1,
      };
      spec.metadata.name = 'DogeOS Testnet';
      spec.signing = {
        cubesigner: { roles: [] },
      };
      const output = generateDogeConfigToml(spec);

      expect(output).not.to.include('awsSigner');
      expect(output).not.to.include('dummySigner');
    });

    it('includes local signer config', () => {
      const spec = createMinimalSpec();
      spec.signing = {
        cubesigner: { roles: [] },
        local: { signers: [{ index: 0, port: 8080 }] },
      };
      const output = generateDogeConfigToml(spec);

      expect(output).to.include('localSigners');
      expect(output).to.include('network = "testnet"');
      expect(output).to.include('dummySigner');
      expect(output).to.include('provider = "local"');
    });

    it('includes TSO service URL when present', () => {
      const spec = createMinimalSpec();
      spec.signing.tsoServiceUrl = 'http://tso:9090';
      const output = generateDogeConfigToml(spec);

      expect(output).to.include('http://tso:9090');
    });

    it('sets dummy signer provider from signing config independently from infrastructure provider', () => {
      const awsSpec = createMinimalSpec();
      awsSpec.infrastructure.provider = 'local';
      awsSpec.signing = {
        awsKms: { accountId: '1', region: 'r' },
        cubesigner: { roles: [] },
      };
      const awsOutput = toml.parse(generateDogeConfigToml(awsSpec)) as any;
      expect(awsOutput.dummySigner.provider).to.equal('aws');

      const localSpec = createMinimalSpec();
      localSpec.infrastructure.provider = 'aws';
      localSpec.infrastructure.aws = { accountId: '1', eksClusterName: 'c', region: 'r' };
      localSpec.signing = {
        cubesigner: { roles: [] },
        local: { signers: [] },
      };
      const localOutput = toml.parse(generateDogeConfigToml(localSpec)) as any;
      expect(localOutput.dummySigner.provider).to.equal('local');
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
      expect(output).to.include('recovery_key_count');
      expect(output).not.to.include('correctness_key_count');
      expect(output).not.to.include('correctness_threshold');
      expect(output).not.to.include('sequencer_threshold');
    });

    it('includes TEE public key when configured', () => {
      const spec = createMinimalSpec();
      spec.bridge.teePubkey = '0x020000000000000000000000000000000000000000000000000000000000000000';
      const output = generateSetupDefaultsToml(spec);

      expect(output).to.include('tee_pubkey = "020000000000000000000000000000000000000000000000000000000000000000"');
    });

    it('outputs timelock using setup_defaults.toml field name', () => {
      const spec = createMinimalSpec();
      const output = generateSetupDefaultsToml(spec);

      expect(output).to.match(/timelock = 86_?400/);
      expect(output).not.to.include('timelock_seconds');
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
      expect(output).to.include('https://dogecoin-external.example.com');
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
      expect(output).to.include('0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A');
    });

    it('includes an editable base funding UTXO placeholder', () => {
      const spec = createMinimalSpec() as any;
      spec.bridge.baseFundingUtxos = [{
        amountSats: 7_000_000_000,
        prevTxHex: '0100000000',
        txid: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        vout: 1,
      }];
      const output = generateSetupDefaultsToml(spec);

      expect(output).to.include('[[base_funding_utxos]]');
      expect(output).to.include('txid = "<txid of the DOGE sent to the helper address>"');
      expect(output).to.include('vout = 0');
      expect(output).to.include('amount_sats = 7_000_000_000');
      expect(output).to.include('prev_tx_hex = "<raw tx hex of the funding tx>"');
      expect(output).not.to.include('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    });

    it('includes TEE pubkey from the cubesigner role when bridge teePubkey is omitted', () => {
      const spec = createMinimalSpec();
      spec.signing = {
        cubesigner: {
          roles: [
            { keys: [{ keyId: 'k1', keyType: 'secp256k1', materialId: 'm1', publicKey: '0xabc123' }], name: 'r1', roleId: 'id1' },
            { keys: [{ keyId: 'k2', keyType: 'secp256k1', materialId: 'm2', publicKey: '0xdef456' }], name: 'r2', roleId: 'id2' },
          ],
        },
      };
      const output = generateSetupDefaultsToml(spec);

      expect(output).to.include('tee_pubkey = "abc123"');
      expect(output).not.to.include('attestation_pubkeys');
      expect(output).not.to.include('def456');
    });
  });

  describe('generateAllConfigs', () => {
    it('returns all config files', () => {
      const spec = createMinimalSpec();
      const configs = generateAllConfigs(spec);

      expect(configs).to.have.property('config.toml');
      expect(configs).to.have.property('doge-config.toml');
      expect(configs).to.have.property('setup_defaults.toml');
      expect(configs).to.have.property('protocol_seed.toml');

      expect(configs['config.toml']).to.be.a('string').and.not.be.empty;
      expect(configs['doge-config.toml']).to.be.a('string').and.not.be.empty;
      expect(configs['setup_defaults.toml']).to.be.a('string').and.not.be.empty;
      expect(configs['protocol_seed.toml']).to.be.a('string').and.not.be.empty;
    });

    it('uses doge-config.toml as the Dogecoin network source for generated files', () => {
      const spec = createMinimalSpec();
      spec.dogecoin.network = 'testnet';

      const configs = generateAllConfigs(spec);
      const configToml = toml.parse(configs['config.toml']) as any;
      const dogeConfig = toml.parse(configs['doge-config.toml']) as any;
      const setupDefaults = toml.parse(configs['setup_defaults.toml']) as any;
      const protocolSeed = toml.parse(configs['protocol_seed.toml']) as any;

      expect(configToml).not.to.have.property('dogecoin');
      expect(dogeConfig.network).to.equal('testnet');
      expect(setupDefaults.network).to.equal('testnet');
      expect(protocolSeed.protocol.dogecoin_chain_id).to.equal(111_111);
    });
  });

  describe('generateProtocolSeedToml', () => {
    it('generates protocol seed from spec values with contract placeholders', () => {
      const spec = createMinimalSpec();
      spec.ethereumDa = {
        ...spec.ethereumDa,
        chain: 'sepolia',
        chainId: 11_155_111,
      };
      spec.network.l2ChainId = 412_346;
      spec.rollup.maxL1MessageGasLimit = 1_000_000;

      const parsed = toml.parse(generateProtocolSeedToml(spec)) as any;

      expect(parsed.protocol).to.deep.equal({
        dogecoin_chain_id: 111_111,
        eth_chain_id: 11_155_111,
        l2_chain_id: 412_346,
        protocol_version: 2,
      });
      expect(parsed.chain_anchors).to.deep.equal({
        genesis_batch_hash: '0x0000000000000000000000000000000000000000000000000000000000000000',
        genesis_state_root: '0x0000000000000000000000000000000000000000000000000000000000000000',
        initial_ethereum_block_hash: '0x0000000000000000000000000000000000000000000000000000000000000000',
        initial_tx_blob_index: 0,
        initial_tx_index: 0,
      });
      expect(parsed.protocol_config_seed.protocol_config).to.deep.equal({
        deposit_queue_transform: {
          l1_scroll_messenger_address: '0x0000000000000000000000000000000000000001',
          l2_messenger_address: '0x0000000000000000000000000000000000000002',
          message_queue_gas_limit: 1_000_000,
          moat_address: '0x0000000000000000000000000000000000000003',
        },
        eth_chain_id: 11_155_111,
        key_rotation_min_grace_wf_txs: 100,
        l2_chain_id: 412_346,
        min_deposit_sats: 100_000,
      });
    });

    it('uses Dogecoin mainnet and regtest protocol chain IDs', () => {
      const mainnet = createMinimalSpec();
      mainnet.dogecoin.network = 'mainnet';
      const regtest = createMinimalSpec();
      regtest.dogecoin.network = 'regtest';

      expect((toml.parse(generateProtocolSeedToml(mainnet)) as any).protocol.dogecoin_chain_id).to.equal(1);
      expect((toml.parse(generateProtocolSeedToml(regtest)) as any).protocol.dogecoin_chain_id).to.equal(5_555_555);
    });
  });

  describe('generateValuesFiles', () => {
    it('generates Ethereum DA submitter values instead of legacy Celestia DA services', () => {
      const spec = createMinimalSpec();
      spec.infrastructure = {
        aws: { accountId: '1', eksClusterName: 'cluster', region: 'us-west-2', secretsPrefix: 'dogeos-test' },
        bootnodeCount: 1,
        provider: 'aws',
        sequencerCount: 1,
      };
      const files = generateValuesFiles(spec);

      expect(files).to.have.property('eth-da-submitter-production.yaml');
      expect(files).to.have.property('fee-oracle-production.yaml');
      expect(files).to.have.property('l1-devnet-production.yaml');
      expect(files).to.have.property('withdrawal-processor-production.yaml');
      expect(files).not.to.have.property('ethereum-production.yaml');
      expect(files).not.to.have.property('celestia-node-production.yaml');
      expect(files).not.to.have.property('da-publisher-production.yaml');
      expect(files).not.to.have.property('rollup-relayer-production.yaml');

      expect(files['eth-da-submitter-production.yaml']).to.include('DOGEOS_ETH_DA_SUBMITTER_ETHEREUM__SUBMITTER_PRIVATE_KEY');
      expect(files['eth-da-submitter-production.yaml']).to.include('dogeos-test/eth-da-submitter-secret-env');
      expect(files['eth-da-submitter-production.yaml']).to.include('DOGEOS_ETH_DA_SUBMITTER_ETHEREUM__RPC_URL');
      expect(files['l1-devnet-production.yaml']).to.include('chainId: 11155111');
      expect(files['l1-devnet-production.yaml']).to.include('networkId: 11155111');
      expect(files['l1-interface-production.yaml']).to.include('DOGEOS_L1_INTERFACE_ETHEREUM_DA__L1_RPC_URL');
      expect(files['l1-interface-production.yaml']).to.include('DOGEOS_L1_INTERFACE_ETHEREUM_DA__ETH_CHAIN_ID');
      expect(files['l1-interface-production.yaml']).to.include('DOGEOS_L1_INTERFACE_ETHEREUM_DA__L2_CHAIN_ID');
      expect(files['l1-interface-production.yaml']).to.include('DOGEOS_L1_INTERFACE_ETHEREUM_DA__BLOB_SOURCE__BEACON_NODE__URL');
      expect(files['l1-interface-production.yaml']).not.to.include('DOGEOS_L1_INTERFACE_ETHEREUM_DA__BLOB_SOURCE__KIND');
      expect(files['withdrawal-processor-production.yaml']).to.include('DOGEOS_WITHDRAWAL_ETHEREUM_DA__INDEXER_SQLITE_PATH');
      expect(files['withdrawal-processor-production.yaml']).to.include('DOGEOS_WITHDRAWAL_ETHEREUM_DA__ARTIFACT_STORE_ROOT');
      expect(files['withdrawal-processor-production.yaml']).to.include('DOGEOS_WITHDRAWAL_ETHEREUM_DA__ARTIFACT_METADATA_SQLITE_PATH');
      expect(files['withdrawal-processor-production.yaml']).to.include('DOGEOS_WITHDRAWAL_ETHEREUM_DA__INBOX_WORKER__START_BLOCK');
      expect(files['withdrawal-processor-production.yaml']).to.include('DOGEOS_WITHDRAWAL_ETHEREUM_DA__BLOB_SOURCE__BEACON_NODE__URL');
      expect(files['withdrawal-processor-production.yaml']).not.to.include('DOGEOS_WITHDRAWAL_ETHEREUM_DA__BLOB_SOURCE__KIND');
      expect(files['withdrawal-processor-production.yaml']).not.to.include('DOGEOS_WITHDRAWAL_ETHEREUM_DA__BLOB_SOURCES__BEACON__ENDPOINT');
      expect(files['dogecoin-production.yaml']).to.include('rpcuser: cluster-rpc-user');
      expect(files['dogecoin-production.yaml']).to.include('value: cluster-rpc-pass');
      expect(files['dogecoin-production.yaml']).not.to.include('external-rpc-user');
      expect(files['dogecoin-production.yaml']).not.to.include('external-rpc-pass');
      expect(files['l2-rpc-production.yaml']).to.include('L2GETH_DA_BLOB_BEACON_NODE: http://l1-interface:5052');
      expect(files['l2-rpc-production.yaml']).to.include('L2GETH_L1_ENDPOINT: http://l1-interface:8545');
      expect(files['l2-bootnode-production.yaml']).to.include('L2GETH_DA_BLOB_BEACON_NODE: http://l1-interface:5052');
      expect(files['l2-bootnode-production.yaml']).to.include('L2GETH_L1_ENDPOINT: http://l1-interface:8545');
      expect(files['l2-sequencer-production.yaml']).to.include('L2GETH_L1_ENDPOINT: http://l1-interface:8545');
      expect(files['contracts-production.yaml']).to.include('SCROLL_L1_FEE_VAULT_ADDR: \'0x1111111111111111111111111111111111111111\'');

      const feeOracleValues = yaml.load(files['fee-oracle-production.yaml']) as any;
      const feeOracleEnv = feeOracleValues.configMaps.env.data;
      expect(feeOracleEnv.DOGEOS_FEE_ORACLE_ETHEREUM_DA__CONTRACT_WRITE_MODE).to.equal('dry_run');
      expect(feeOracleEnv.DOGEOS_FEE_ORACLE_ETHEREUM_DA__ETH_RPC_URL).to.equal('https://sepolia.drpc.org');
      expect(feeOracleEnv.DOGEOS_FEE_ORACLE_ETHEREUM_DA__MIN_PRIORITY_FEE_PER_GAS_WEI).to.equal('"0"');
      expect(feeOracleEnv.DOGEOS_FEE_ORACLE_L2__CHAIN_ID).to.equal(String(spec.network.l2ChainId));
      expect(feeOracleValues.envFrom).to.deep.equal([{ configMapRef: { name: 'fee-oracle-env' } }]);
      expect(files['fee-oracle-production.yaml']).not.to.include('DOGEOS_FEE_ORACLE_DOGECOIN__');
      expect(files['fee-oracle-production.yaml']).not.to.include('DOGEOS_FEE_ORACLE_CELESTIA__');
      expect(files['fee-oracle-production.yaml']).not.to.include('FEE_ORACLE_DOGE_RPC_URL');
      expect(feeOracleValues).not.to.have.property('externalSecrets');
    });

    it('generates scroll-reth L2 values when executionClient backend is scroll-reth', () => {
      const spec = createMinimalSpec();
      spec.executionClient = { backend: 'scroll-reth' };
      spec.infrastructure.sequencers = [{
        enodeUrl: 'enode://sequencer@example.com:30303',
        index: 0,
        signerAddress: '0x1234567890123456789012345678901234567890',
      }];
      spec.infrastructure.bootnodes = [{
        enodeUrl: 'enode://bootnode@example.com:30303',
        index: 0,
        publicEndpoint: 'bootnode.example.com:30303',
      }];

      const files = generateValuesFiles(spec);
      const l2Files = [
        files['l2-sequencer-production.yaml'],
        files['l2-bootnode-production.yaml'],
        files['l2-rpc-production.yaml'],
      ];

      for (const output of l2Files) {
        expect(output).to.include('ghcr.io/dogeos69/scroll-reth');
        expect(output).to.include('dogeos-revm-c1cd6f4');
        expect(output).to.include('L2RETH_L1_ENDPOINT: http://l1-interface:8545');
        expect(output).to.include('exec dogeos-reth-entrypoint');
        expect(output).not.to.include('L2GETH_');
      }

      const sequencerValues = yaml.load(files['l2-sequencer-production.yaml']) as any;
      expect(sequencerValues.command).to.deep.equal(['bash', '-c', 'exec dogeos-reth-entrypoint']);
      expect(sequencerValues.configMaps.env.data.L2RETH_ROLE).to.equal('sequencer');
      expect(sequencerValues.configMaps.env.data.L2RETH_VALID_SIGNER).to.equal('__SEQUENCER_SIGNER_ADDRESS__');
      expect(sequencerValues.envFrom).to.deep.equal([{ configMapRef: { name: 'l2-sequencer-__INSTANCE_INDEX__-env' } }]);
      expect(sequencerValues.persistence.data.mountPath).to.equal('/l2reth/reth-data');
      expect(sequencerValues.persistence.genesis.mountPath).to.equal('/l2reth/genesis/genesis.json');
      expect(sequencerValues).not.to.have.property('externalSecrets');

      const bootnodeValues = yaml.load(files['l2-bootnode-production.yaml']) as any;
      expect(bootnodeValues.configMaps.env.data.L2RETH_ROLE).to.equal('bootnode');
      expect(bootnodeValues.persistence.data.mountPath).to.equal('/l2reth/reth-data');

      const rpcValues = yaml.load(files['l2-rpc-production.yaml']) as any;
      expect(rpcValues.configMaps.env.data.L2RETH_ROLE).to.equal('rpc');
      expect(rpcValues.volumeClaimTemplates[0].mountPath).to.equal('/l2reth/reth-data');
    });

    it('generates l1-interface genesis and indexer heights independently', () => {
      const spec = createMinimalSpec();
      spec.dogecoin.indexerStartHeight = 8_200_000;
      spec.dogecoin.l1GenesisBlock = 8_208_200;

      const files = generateValuesFiles(spec);
      const l1InterfaceValues = yaml.load(files['l1-interface-production.yaml']) as any;
      const envData = l1InterfaceValues.configMaps.env.data;

      expect(envData.DOGEOS_L1_INTERFACE_L1_GENESIS_BLOCK).to.equal('8208200');
      expect(envData.DOGEOS_L1_INTERFACE_DOGECOIN_INDEXER__START_HEIGHT).to.equal('8200000');
    });

    it('defaults Ethereum DA submitter batch compression to auto', () => {
      const defaultSpec = createMinimalSpec();
      const defaultFiles = generateValuesFiles(defaultSpec);
      const defaultSubmitterValues = yaml.load(defaultFiles['eth-da-submitter-production.yaml']) as any;

      expect(defaultSubmitterValues.configMaps.env.data.DOGEOS_ETH_DA_SUBMITTER_BATCH__COMPRESSION).to.equal('auto');

      const explicitSpec = createMinimalSpec();
      explicitSpec.ethereumDa!.batch = { compression: 'none' };
      const explicitFiles = generateValuesFiles(explicitSpec);
      const explicitSubmitterValues = yaml.load(explicitFiles['eth-da-submitter-production.yaml']) as any;

      expect(explicitSubmitterValues.configMaps.env.data.DOGEOS_ETH_DA_SUBMITTER_BATCH__COMPRESSION).to.equal('none');
    });

    it('generates Ethereum DA S3 upload and readback env', () => {
      const spec = createMinimalSpec();
      spec.ethereumDa!.blobArchive = {
        s3: {
          bucket: 'dogeos-da',
          enabled: true,
          maxRetries: 5,
          publicBaseUrl: 'https://dogeos-da.s3.us-east-1.amazonaws.com/',
          region: 'us-east-1',
          timeoutMs: 15_000,
          treatForbiddenAsMissing: false,
        },
      };

      const files = generateValuesFiles(spec);
      const submitterValues = yaml.load(files['eth-da-submitter-production.yaml']) as any;
      const l1InterfaceValues = yaml.load(files['l1-interface-production.yaml']) as any;
      const withdrawalValues = yaml.load(files['withdrawal-processor-production.yaml']) as any;
      const withdrawalEnv = Object.fromEntries(withdrawalValues.env.map((item: any) => [item.name, item.value]));

      expect(submitterValues.configMaps.env.data.DOGEOS_ETH_DA_SUBMITTER_S3__ENABLED).to.equal('true');
      expect(submitterValues.configMaps.env.data.DOGEOS_ETH_DA_SUBMITTER_S3__BUCKET).to.equal('dogeos-da');
      expect(submitterValues.configMaps.env.data.DOGEOS_ETH_DA_SUBMITTER_S3__REGION).to.equal('us-east-1');
      expect(submitterValues.configMaps.env.data.DOGEOS_ETH_DA_SUBMITTER_S3__MAX_RETRIES).to.equal('5');
      expect(l1InterfaceValues.configMaps.env.data.DOGEOS_L1_INTERFACE_ETHEREUM_DA__BLOB_SOURCE__AWS_S3__URL).to.equal('https://dogeos-da.s3.us-east-1.amazonaws.com/');
      expect(l1InterfaceValues.configMaps.env.data.DOGEOS_L1_INTERFACE_ETHEREUM_DA__BLOB_SOURCE__AWS_S3__TIMEOUT_MS).to.equal('15000');
      expect(l1InterfaceValues.configMaps.env.data.DOGEOS_L1_INTERFACE_ETHEREUM_DA__BLOB_SOURCE__AWS_S3__TREAT_FORBIDDEN_AS_MISSING).to.equal('false');
      expect(withdrawalEnv.DOGEOS_WITHDRAWAL_ETHEREUM_DA__BLOB_SOURCE__AWS_S3__URL).to.equal('https://dogeos-da.s3.us-east-1.amazonaws.com/');
      expect(withdrawalEnv.DOGEOS_WITHDRAWAL_ETHEREUM_DA__BLOB_SOURCE__AWS_S3__TIMEOUT_MS).to.equal('15000');
      expect(withdrawalEnv.DOGEOS_WITHDRAWAL_ETHEREUM_DA__BLOB_SOURCE__AWS_S3__TREAT_FORBIDDEN_AS_MISSING).to.equal('false');
    });

    it('uses Ethereum DA inbox worker start block for withdrawal processor values', () => {
      const spec = createMinimalSpec();
      spec.dogecoin.indexerStartHeight = 8_200_000;
      spec.ethereumDa!.inboxWorker = { startBlock: 12_345_678 };

      const files = generateValuesFiles(spec);
      const withdrawalValues = yaml.load(files['withdrawal-processor-production.yaml']) as any;
      const withdrawalEnv = Object.fromEntries(withdrawalValues.env.map((item: any) => [item.name, item.value]));

      expect(withdrawalEnv.DOGEOS_WITHDRAWAL_DOGECOIN_INDEXER__START_HEIGHT).to.equal('8200000');
      expect(withdrawalEnv.DOGEOS_WITHDRAWAL_ETHEREUM_DA__INBOX_WORKER__START_BLOCK).to.equal('12345678');
    });
  });

  describe('loadDeploymentSpec', () => {
    let tempDir: string;

    beforeEach(() => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deployment-spec-test-'));
    });

    afterEach(() => {
      fs.rmSync(tempDir, { force: true, recursive: true });
    });

    it('loads and parses a valid YAML spec', () => {
      const specPath = path.join(tempDir, 'spec.yaml');
      const yamlContent = `
version: "1.0"
metadata:
  name: test
  environment: testnet
`;
      fs.writeFileSync(specPath, yamlContent);

      const spec = loadDeploymentSpec(specPath);
      expect(spec.version).to.equal('1.0');
      expect(spec.metadata?.name).to.equal('test');
    });

    it('throws when version field is missing', () => {
      const specPath = path.join(tempDir, 'spec.yaml');
      fs.writeFileSync(specPath, 'metadata:\n  name: test\n');

      expect(() => loadDeploymentSpec(specPath)).to.throw('DeploymentSpec must have a version field');
    });

    it('throws when file does not exist', () => {
      expect(() => loadDeploymentSpec('/nonexistent/path.yaml')).to.throw();
    });
  });

  describe('writeGeneratedConfigs', () => {
    let tempDir: string;

    beforeEach(() => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'write-configs-test-'));
    });

    afterEach(() => {
      fs.rmSync(tempDir, { force: true, recursive: true });
    });

    it('writes all config files to output directory', () => {
      const configs = {
        'config.toml': '[general]\nkey = "value"\n',
        'doge-config.toml': '[wallet]\npath = ".data/doge-wallet-testnet.json"\n',
        'protocol_seed.toml': '[protocol]\nprotocol_version = 2\n',
        'setup_defaults.toml': 'seed_string = "test"\n',
      };

      writeGeneratedConfigs(configs, tempDir);

      expect(fs.existsSync(path.join(tempDir, 'config.toml'))).to.be.true;
      expect(fs.existsSync(path.join(tempDir, '.data', 'doge-config.toml'))).to.be.true;
      expect(fs.existsSync(path.join(tempDir, '.data', 'setup_defaults.toml'))).to.be.true;
      expect(fs.existsSync(path.join(tempDir, '.data', 'protocol_seed.toml'))).to.be.true;

      const configContent = fs.readFileSync(path.join(tempDir, 'config.toml'), 'utf8');
      expect(configContent).to.include('key = "value"');
    });

    it('creates output directory if it does not exist', () => {
      const newDir = path.join(tempDir, 'nested', 'dir');
      const configs = {
        'config.toml': 'content',
        'doge-config.toml': 'content',
        'protocol_seed.toml': 'content',
        'setup_defaults.toml': 'content',
      };

      writeGeneratedConfigs(configs, newDir);

      expect(fs.existsSync(newDir)).to.be.true;
      expect(fs.existsSync(path.join(newDir, 'config.toml'))).to.be.true;
    });

    it('uses custom doge config path when specified', () => {
      const customDogeDir = path.join(tempDir, 'custom-doge');
      const configs = {
        'config.toml': 'content',
        'doge-config.toml': 'doge content',
        'protocol_seed.toml': 'protocol content',
        'setup_defaults.toml': 'setup content',
      };

      writeGeneratedConfigs(configs, tempDir, customDogeDir);

      expect(fs.existsSync(path.join(customDogeDir, 'doge-config.toml'))).to.be.true;
      expect(fs.existsSync(path.join(customDogeDir, 'setup_defaults.toml'))).to.be.true;
      expect(fs.existsSync(path.join(customDogeDir, 'protocol_seed.toml'))).to.be.true;
    });
  });
});
