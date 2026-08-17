import { expect } from 'chai'
import * as yaml from 'js-yaml'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import SetupGenRpcPackage, {
  convertPeersToExternalDomains,
  normalizeConfigMapEnvData,
  normalizeGenesisForReth,
  syncRpcPackageInitContainersToCompose,
} from '../../../src/commands/setup/gen-rpc-package.js'

interface CommandHarness {
  extractGenesisJson(valuesDir: string, rpcPackageDir: string, network: string): string
  generateL1InterfaceEnvFile(valuesDir: string, rpcPackageDir: string, network: string, config?: unknown): string
  generateL2NodeEnvFiles(
    config: unknown,
    dogeConfig: unknown,
    rpcPackageDir: string,
    loadBalancerDomains: Record<string, string>,
    namespace: string,
    valuesDir: string,
  ): { hasUnresolvedExternalPeers: boolean }
  log(): void
  warn(): void
}

interface ComposeService {
  [key: string]: unknown
}

interface TestComposeFile {
  services: Record<string, ComposeService>
  volumes: Record<string, unknown>
}

function createCommandHarness(): CommandHarness {
  return Object.assign(Object.create(SetupGenRpcPackage.prototype), {
    log() {},
    warn() {},
  }) as CommandHarness
}

describe('setup gen-rpc-package env generation', () => {
  let tmpDir: string
  const networkEnvDir = `./envs/\${NETWORK}`

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrollsdk-gen-rpc-package-'))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { force: true, recursive: true })
  })

  it('normalizes configMap env data and drops Celestia variables', () => {
    const env = normalizeConfigMapEnvData({
      CHAIN_ID: 6_281_971,
      DOGEOS_L1_INTERFACE_CELESTIA_INDEXER__DA_RPC_URL: 'http://celestia-light-node:26658',
      L2GETH_L1_ENDPOINT: 'http://l1-interface:8545',
    })

    expect(env).to.deep.equal({
      CHAIN_ID: '6281971',
      L2GETH_L1_ENDPOINT: 'http://l1-interface:8545',
    })
  })

  it('writes a Reth-normalized genesis without modifying the Geth source', () => {
    const valuesDir = path.join(tmpDir, 'values')
    const rpcPackageDir = path.join(tmpDir, 'dogeos-rpc-package')
    fs.mkdirSync(valuesDir, { recursive: true })

    const genesisJson = JSON.stringify({
      config: {
        galileoTime: 1_785_399_093,
        scroll: {
          l1Config: {
            l1ChainId: '111111',
            l1MessageQueueV2DeploymentBlock: 0,
            numL1MessagesPerBlock: '10',
          },
        },
        systemContract: {
          system_contract_address: '0x2000369731833cBf00e97146999442ADf10a4E59',
        },
      },
      marker: 'preserved',
    })
    const genesisYamlContent = yaml.dump({ scrollConfig: genesisJson })
    const genesisYamlPath = path.join(valuesDir, 'genesis.yaml')
    fs.writeFileSync(genesisYamlPath, genesisYamlContent)
    fs.writeFileSync(
      path.join(valuesDir, 'l2-rpc-production.yaml'),
      yaml.dump({
        configMaps: {
          env: {
            data: {
              L2GETH_L1_CONTRACT_DEPLOYMENT_BLOCK: '14023282',
            },
          },
        },
      }),
    )

    const command = createCommandHarness()
    const outputPath = command.extractGenesisJson(valuesDir, rpcPackageDir, 'testnet')
    const output = JSON.parse(fs.readFileSync(outputPath, 'utf8'))

    expect(outputPath).to.equal(path.join(rpcPackageDir, 'configs', 'testnet', 'l2reth-genesis.json'))
    expect(output.config.scroll.l1DataFeeBufferCheck).to.equal(false)
    expect(output.config.scroll.l1Config.l1ChainId).to.equal(111_111)
    expect(output.config.scroll.l1Config.numL1MessagesPerBlock).to.equal(10)
    expect(output.config.scroll.l1Config.l1MessageQueueV2DeploymentBlock).to.equal(0)
    expect(output.config.scroll.l1Config.startL1Block).to.equal(14_023_282)
    expect(output.config.scroll.l1Config.systemContractAddress).to.equal(
      '0x2000369731833cBf00e97146999442ADf10a4E59',
    )
    expect(output.config.galileoTime).to.equal(1_785_399_093)
    expect(output.marker).to.equal('preserved')
    expect(fs.readFileSync(genesisYamlPath, 'utf8')).to.equal(genesisYamlContent)
  })

  it('normalizes Reth metadata idempotently and rejects conflicting source values', () => {
    const source = {
      config: {
        scroll: {
          l1Config: {
            l1ChainId: '111111',
            numL1MessagesPerBlock: '10',
            startL1Block: '14023282',
            systemContractAddress: '0x2000369731833cbf00e97146999442adf10a4e59',
          },
          l1DataFeeBufferCheck: true,
        },
        systemContract: {
          system_contract_address: '0x2000369731833cBf00e97146999442ADf10a4E59',
        },
      },
    }
    const sourceBefore = JSON.parse(JSON.stringify(source))
    const normalized = normalizeGenesisForReth(source, '14023282')

    expect(source).to.deep.equal(sourceBefore)
    expect(normalized.config.scroll.l1DataFeeBufferCheck).to.equal(true)
    expect(normalized.config.scroll.l1Config.startL1Block).to.equal(14_023_282)
    expect(normalizeGenesisForReth(normalized, 14_023_282)).to.deep.equal(normalized)

    expect(() => normalizeGenesisForReth({
      config: {
        scroll: {
          l1Config: {
            l1ChainId: 'not-a-number',
            numL1MessagesPerBlock: '10',
          },
        },
        systemContract: {
          system_contract_address: '0x2000369731833cBf00e97146999442ADf10a4E59',
        },
      },
    }, 14_023_282)).to.throw('l1ChainId')

    expect(() => normalizeGenesisForReth({
      config: {
        scroll: {
          l1Config: {
            l1ChainId: '111111',
            numL1MessagesPerBlock: '10',
            startL1Block: 1,
          },
        },
        systemContract: {
          system_contract_address: '0x2000369731833cBf00e97146999442ADf10a4E59',
        },
      },
    }, 14_023_282)).to.throw('startL1Block conflicts')
  })

  it('converts internal bootnode enodes to public p2p LoadBalancer domains', () => {
    const peers = convertPeersToExternalDomains(
      [
        'enode://abc@l2-bootnode-0:30303',
        'enode://jkl@l2-reth-bootnode-1.default.svc.cluster.local:30303',
        'enode://def@l2-sequencer-1.default.svc.cluster.local:30303',
        'enode://ghi@external.example.com:30303',
      ],
      {
        'l2-bootnode-0-p2p': 'bootnode-0.example.com',
        'l2-reth-bootnode-1-p2p': 'reth-bootnode-1.example.com',
      },
    )

    expect(peers).to.deep.equal([
      'enode://abc@bootnode-0.example.com:30303',
      'enode://jkl@reth-bootnode-1.example.com:30303',
      'enode://def@l2-sequencer-1.default.svc.cluster.local:30303',
      'enode://ghi@external.example.com:30303',
    ])
  })

  it('drops optional bootnode peers without matching public p2p services', () => {
    const rethOnlyPeers = convertPeersToExternalDomains(
      [
        'enode://geth0@l2-bootnode-0:30303',
        'enode://reth0@l2-reth-bootnode-0:30303',
        'enode://external@external.example.com:30303',
      ],
      {
        'l2-reth-bootnode-0-p2p': 'reth-bootnode-0.example.com',
      },
    )

    expect(rethOnlyPeers).to.deep.equal([
      'enode://reth0@reth-bootnode-0.example.com:30303',
      'enode://external@external.example.com:30303',
    ])

    const gethOnlyPeers = convertPeersToExternalDomains(
      [
        'enode://geth0@l2-bootnode-0:30303',
        'enode://reth0@l2-reth-bootnode-0:30303',
      ],
      {
        'l2-bootnode-0-p2p': 'geth-bootnode-0.example.com',
      },
    )

    expect(gethOnlyPeers).to.deep.equal([
      'enode://geth0@geth-bootnode-0.example.com:30303',
    ])
  })

  it('writes only l2reth env and combines geth and Reth bootnode peers', () => {
    const valuesDir = path.join(tmpDir, 'values')
    const rpcPackageDir = path.join(tmpDir, 'dogeos-rpc-package')
    fs.mkdirSync(valuesDir, { recursive: true })
    fs.mkdirSync(path.join(rpcPackageDir, 'envs', 'testnet'), { recursive: true })

    fs.writeFileSync(
      path.join(valuesDir, 'l2-rpc-production.yaml'),
      yaml.dump({
        configMaps: {
          env: {
            data: {
              CHAIN_ID: '6281971',
              L2GETH_DA_BLOB_BEACON_NODE: 'http://l1-interface:5052',
              L2GETH_L1_CONTRACT_DEPLOYMENT_BLOCK: '14023282',
              L2GETH_L1_ENDPOINT: 'http://l1-interface:8545',
              L2GETH_PEER_LIST: JSON.stringify(['enode://abc@l2-sequencer-0:30303']),
            },
          },
        },
      }),
    )

    fs.writeFileSync(
      path.join(valuesDir, 'l2-reth-rpc-production.yaml'),
      yaml.dump({ reth: { networkId: '4444444' } }),
    )

    fs.writeFileSync(
      path.join(valuesDir, 'l2-reth-bootnode-production-0.yaml'),
      yaml.dump({
        reth: {
          enodeUrl: 'enode://reth0@l2-reth-bootnode-0:30303',
        },
      }),
    )
    fs.writeFileSync(
      path.join(valuesDir, 'l2-reth-bootnode-production-1.yaml'),
      yaml.dump({
        reth: {
          trustedPeers: [
            'enode://sequencer@l2-reth-sequencer-0:30303',
            'enode://reth1@l2-reth-bootnode-1.default.svc.cluster.local:30303',
          ].join(','),
        },
      }),
    )

    fs.writeFileSync(
      path.join(rpcPackageDir, 'envs', 'testnet', 'l2geth.env'),
      [
        '# existing',
        'CHAIN_ID=1',
        'L2RETH_VALID_SIGNER=0xold',
        '',
      ].join('\n'),
    )
    fs.writeFileSync(
      path.join(rpcPackageDir, 'envs', 'testnet', 'l2reth.env'),
      [
        '# existing',
        'CHAIN_ID=1',
        'L2GETH_L1_ENDPOINT=http://old-l1',
        'L2RETH_DA_BLOB_BEACON_NODE=https://stale-beacon.example',
        'L2RETH_NETWORK_ID=9999999',
        '',
      ].join('\n'),
    )

    const command = createCommandHarness()
    const result = command.generateL2NodeEnvFiles(
      {
        bootnode: {
          L2_GETH_PUBLIC_PEERS: [
            'enode://geth0@l2-bootnode-0:30303',
            'enode://geth1@l2-bootnode-1:30303',
          ],
        },
        sequencer: {
          L2GETH_SIGNER_ADDRESS: '0x1234567890123456789012345678901234567890',
        },
      },
      {
        defaults: { dogecoinIndexerStartHeight: '14023282' },
        ethereumDa: {
          blobArchive: {
            s3: {
              enabled: true,
              keyPrefix: '/rehearsal/batches/',
              publicBaseUrl: 'https://dogeos-eth-da-archive-testnet.s3.us-west-2.amazonaws.com/',
            },
          },
        },
        network: 'testnet',
      },
      rpcPackageDir,
      {
        'l2-bootnode-0-p2p': 'bootnode-0.example.com',
        'l2-bootnode-1-p2p': 'bootnode-1.example.com',
        'l2-reth-bootnode-0-p2p': 'reth-bootnode-0.example.com',
        'l2-reth-bootnode-1-p2p': 'reth-bootnode-1.example.com',
        'l2-sequencer-0-p2p': 'sequencer-0.example.com',
      },
      'default',
      valuesDir,
    )

    expect(result.hasUnresolvedExternalPeers).to.equal(false)

    expect(fs.existsSync(path.join(rpcPackageDir, 'envs', 'testnet', 'l2geth.env'))).to.equal(false)

    const l2rethEnv = fs.readFileSync(path.join(rpcPackageDir, 'envs', 'testnet', 'l2reth.env'), 'utf8')
    expect(l2rethEnv).to.include('L2GETH_PEER_LIST=["enode://geth0@bootnode-0.example.com:30303","enode://geth1@bootnode-1.example.com:30303","enode://reth0@reth-bootnode-0.example.com:30303","enode://reth1@reth-bootnode-1.example.com:30303"]')
    expect(l2rethEnv).to.include('L2RETH_L1_ENDPOINT=http://l1-interface:8545')
    expect(l2rethEnv).to.include('L2RETH_NETWORK_ID=4444444')
    expect(l2rethEnv).to.include('L2RETH_BLOB_S3_URL=https://dogeos-eth-da-archive-testnet.s3.us-west-2.amazonaws.com/rehearsal/batches')
    expect(l2rethEnv).to.include('L2RETH_VALID_SIGNER=0x1234567890123456789012345678901234567890')
    expect(l2rethEnv).not.to.include('CHAIN_ID=1')
    expect(l2rethEnv).not.to.include('L2GETH_L1_ENDPOINT=http://old-l1')
    expect(l2rethEnv).not.to.include('L2RETH_DA_BLOB_BEACON_NODE')
    expect(l2rethEnv).not.to.include('sequencer-0.example.com')
    expect(l2rethEnv).not.to.include('l2-reth-sequencer-0')
  })

  it('omits config geth bootnodes when only Reth public p2p services exist', () => {
    const valuesDir = path.join(tmpDir, 'values')
    const rpcPackageDir = path.join(tmpDir, 'dogeos-rpc-package')
    fs.mkdirSync(valuesDir, { recursive: true })
    fs.mkdirSync(path.join(rpcPackageDir, 'envs', 'testnet'), { recursive: true })

    fs.writeFileSync(
      path.join(valuesDir, 'l2-rpc-production.yaml'),
      yaml.dump({
        configMaps: {
          env: {
            data: {
              CHAIN_ID: '4444444',
              L2GETH_PEER_LIST: JSON.stringify(['enode://sequencer@l2-sequencer-0:30303']),
            },
          },
        },
      }),
    )

    fs.writeFileSync(
      path.join(valuesDir, 'l2-reth-rpc-production.yaml'),
      yaml.dump({ reth: { networkId: '5555555' } }),
    )

    fs.writeFileSync(
      path.join(rpcPackageDir, 'envs', 'testnet', 'l2reth.env'),
      'L2RETH_BLOB_S3_URL=https://stale.example/blobs\n',
    )

    const command = createCommandHarness()
    const result = command.generateL2NodeEnvFiles(
      {
        bootnode: {
          L2_GETH_PUBLIC_PEERS: [
            'enode://legacy0@l2-bootnode-0:30303',
            'enode://legacy1@l2-bootnode-1:30303',
          ],
        },
      },
      {
        bootnodeReth: {
          instances: [
            {
              enodeUrl: 'enode://reth0@l2-reth-bootnode-0:30303',
              index: 0,
            },
            {
              enodeUrl: 'enode://reth1@l2-reth-bootnode-1:30303',
              index: 1,
            },
          ],
        },
        defaults: { dogecoinIndexerStartHeight: '14023282' },
        network: 'testnet',
      },
      rpcPackageDir,
      {
        'l2-reth-bootnode-0-p2p': 'reth-bootnode-0.example.com',
        'l2-reth-bootnode-1-p2p': 'reth-bootnode-1.example.com',
      },
      'default',
      valuesDir,
    )

    expect(result.hasUnresolvedExternalPeers).to.equal(false)

    expect(fs.existsSync(path.join(rpcPackageDir, 'envs', 'testnet', 'l2geth.env'))).to.equal(false)
    const l2rethEnv = fs.readFileSync(path.join(rpcPackageDir, 'envs', 'testnet', 'l2reth.env'), 'utf8')
    expect(l2rethEnv).to.include('L2GETH_PEER_LIST=["enode://reth0@reth-bootnode-0.example.com:30303","enode://reth1@reth-bootnode-1.example.com:30303"]')
    expect(l2rethEnv).to.include('L2RETH_NETWORK_ID=5555555')
    expect(l2rethEnv).not.to.include('legacy0')
    expect(l2rethEnv).not.to.include('legacy1')
    expect(l2rethEnv).not.to.include('LoadBalancer-Domain-For-l2-bootnode')
    expect(l2rethEnv).not.to.include('L2RETH_BLOB_S3_URL')
    expect(l2rethEnv).not.to.include('l2-sequencer-0')
  })

  it('writes only credential-free generated config and leaves package-owned operator files untouched', () => {
    const valuesDir = path.join(tmpDir, 'values')
    const rpcPackageDir = path.join(tmpDir, 'dogeos-rpc-package')
    fs.mkdirSync(valuesDir, { recursive: true })
    fs.mkdirSync(path.join(rpcPackageDir, 'envs', 'testnet'), { recursive: true })

    fs.writeFileSync(
      path.join(valuesDir, 'l1-interface-production.yaml'),
      yaml.dump({
        configMaps: {
          env: {
            data: {
              DOGEOS_L1_INTERFACE_API_BIND_ADDRESS: '0.0.0.0:8545',
              DOGEOS_L1_INTERFACE_BEACON_API_LISTEN_ADDRESS: '0.0.0.0:5052',
              DOGEOS_L1_INTERFACE_CELESTIA_INDEXER__DA_RPC_URL: 'http://celestia-light-node:26658',
              DOGEOS_L1_INTERFACE_CHAIN_ID: '6281971',
              DOGEOS_L1_INTERFACE_DATABASE_URL: 'sqlite:///data/l1-interface-vo3o.sqlite',
              DOGEOS_L1_INTERFACE_DOGECOIN_RPC__URL: 'http://cluster-dogecoin:44555',
              DOGEOS_L1_INTERFACE_DOGECOIN_RPC__USER: 'cluster-user',
              DOGEOS_L1_INTERFACE_ETHEREUM_DA__BLOB_SOURCE__BEACON_NODE__URL: 'http://l1-devnet-lighthouse:5052',
              DOGEOS_L1_INTERFACE_ETHEREUM_DA__L1_RPC_URL: 'https://sepolia.example',
              DOGEOS_L1_INTERFACE_GENESIS_JSON_PATH: '/app/genesis/genesis.json',
              DOGEOS_L1_INTERFACE_HEALTH_LISTEN_ADDRESS: '0.0.0.0:9090',
              DOGEOS_L1_INTERFACE_INITIAL_SYSTEM_SIGNER: '0x1234567890123456789012345678901234567890',
              DOGEOS_L1_INTERFACE_NETWORK_STR: 'testnet',
              DOGEOS_L1_INTERFACE_PRIVATE_TOKEN: 'do-not-copy',
              DOGEOS_L1_INTERFACE_SEQUENCER_GENESIS_MODE: 'true',
            },
          },
        },
      }),
    )

    // A stale generated file from a previous run; full overwrite must drop its keys.
    fs.writeFileSync(
      path.join(rpcPackageDir, 'envs', 'testnet', 'l1-interface.env'),
      [
        '# existing',
        'DOGEOS_L1_INTERFACE_DOGECOIN_RPC__URL=http://dogecoin-node:44555',
        'DOGEOS_L1_INTERFACE_SCROLL_MESSENGER_ADDRESS=0xdeadbeef',
        '',
      ].join('\n'),
    )

    const examplePath = path.join(rpcPackageDir, 'envs', 'testnet', 'l1-interface.local.env.example')
    const localEnvPath = path.join(rpcPackageDir, 'envs', 'testnet', 'l1-interface.local.env')
    const packageOwnedExample = '# package-owned operator template\n'
    const operatorOwnedLocalEnv = 'DOGEOS_L1_INTERFACE_ETHEREUM_DA__L1_RPC_URL=https://operator.example\n'
    fs.writeFileSync(examplePath, packageOwnedExample)
    fs.writeFileSync(localEnvPath, operatorOwnedLocalEnv)

    const command = createCommandHarness()
    command.generateL1InterfaceEnvFile(valuesDir, rpcPackageDir, 'testnet')

    // Generated file: deterministic, non-secret config only.
    const env = fs.readFileSync(path.join(rpcPackageDir, 'envs', 'testnet', 'l1-interface.env'), 'utf8')
    expect(env).to.include('RUST_LOG=info')
    expect(env).to.include('DOGEOS_L1_INTERFACE_API_BIND_ADDRESS=0.0.0.0:8545')
    expect(env).to.include('DOGEOS_L1_INTERFACE_BEACON_API_LISTEN_ADDRESS=0.0.0.0:5052')
    expect(env).not.to.include('DOGEOS_L1_INTERFACE_CHAIN_ID')
    expect(env).to.include('DOGEOS_L1_INTERFACE_DATABASE_URL=sqlite:///data/l1-interface-vo3o.sqlite')
    expect(env).to.include('DOGEOS_L1_INTERFACE_GENESIS_JSON_PATH=/app/genesis/genesis.json')
    expect(env).to.include('DOGEOS_L1_INTERFACE_HEALTH_LISTEN_ADDRESS=0.0.0.0:9090')
    expect(env).to.include('DOGEOS_L1_INTERFACE_NETWORK_STR=testnet')
    // Sequencer genesis mode is forced off no matter what the source says.
    expect(env).to.include('DOGEOS_L1_INTERFACE_SEQUENCER_GENESIS_MODE=false')

    // Operator-owned endpoints/creds, secrets, Celestia, and deprecated keys are excluded.
    expect(env).not.to.include('CELESTIA')
    expect(env).not.to.include('DOGEOS_L1_INTERFACE_DOGECOIN_RPC__URL')
    expect(env).not.to.include('DOGEOS_L1_INTERFACE_DOGECOIN_RPC__USER')
    expect(env).not.to.include('DOGEOS_L1_INTERFACE_ETHEREUM_DA__L1_RPC_URL')
    expect(env).not.to.include('l1-devnet-lighthouse')
    expect(env).not.to.include('PRIVATE_TOKEN')
    expect(env).not.to.include('INITIAL_SYSTEM_SIGNER')
    expect(env).not.to.include('SCROLL_MESSENGER_ADDRESS')
    // Full overwrite: nothing from the stale prior file survives.
    expect(env).not.to.include('# existing')
    expect(env).not.to.include('http://dogecoin-node:44555')
    expect(env).not.to.include('http://cluster-dogecoin:44555')

    // The target package owns its template and the operator owns the real file.
    expect(fs.readFileSync(examplePath, 'utf8')).to.equal(packageOwnedExample)
    expect(fs.readFileSync(localEnvPath, 'utf8')).to.equal(operatorOwnedLocalEnv)

    // A fresh network gets generated config only; CLI does not scaffold package
    // documentation or operator-local configuration.
    command.generateL1InterfaceEnvFile(valuesDir, rpcPackageDir, 'freshnet')
    const freshNetworkDir = path.join(rpcPackageDir, 'envs', 'freshnet')
    expect(fs.existsSync(path.join(freshNetworkDir, 'l1-interface.env'))).to.equal(true)
    expect(fs.existsSync(path.join(freshNetworkDir, 'l1-interface.local.env.example'))).to.equal(false)
    expect(fs.existsSync(path.join(freshNetworkDir, 'l1-interface.local.env'))).to.equal(false)
  })

  it('syncs values initContainers into docker-compose services', () => {
    const valuesDir = path.join(tmpDir, 'values')
    const rpcPackageDir = path.join(tmpDir, 'dogeos-rpc-package')
    fs.mkdirSync(valuesDir, { recursive: true })
    fs.mkdirSync(rpcPackageDir, { recursive: true })

    fs.writeFileSync(
      path.join(rpcPackageDir, 'docker-compose.yml'),
      yaml.dump({
        services: {
          'celestia-light-node': {
            image: 'ghcr.io/celestiaorg/celestia-node:v0.29.3-mocha',
            volumes: ['celestia_data:/home/celestia'],
          },
          'dogecoin-node': {
            image: 'dogeos69/dogecoin:1.14.9',
          },
          'l1-interface': {
            depends_on: ['dogecoin-node', 'celestia-light-node'],
            image: 'dogeos69/l1-interface:0.2.0-rc.7',
            volumes: [
              `./configs/\${NETWORK}/l2geth-genesis.json:/app/genesis/genesis.json:ro`,
              // The ':?' colon inside the expansion must not break mountPath
              // matching when mapping initContainer volumeMounts.
              `\${DATA_ROOT:?DATA_ROOT must be set}/l1-interface:/data`,
            ],
          },
          // Legacy client-orchestrated wait service; the wait loop now lives
          // in scripts/l2reth_entrypoint.sh, so the sync must remove this.
          'l2-rpc-init-wait-for-l1': {
            container_name: 'l2-rpc-init-wait-for-l1',
            depends_on: { 'l1-interface': { condition: 'service_started' } },
            image: 'curlimages/curl:8.20.0',
          },
          'l2geth-node': {
            depends_on: ['l1-interface'],
            env_file: ['./envs/common/l2geth.env', `${networkEnvDir}/l2geth.env`],
            image: 'scrolltech/l2geth:scroll-v5.9.6',
          },
          'l2reth-node': {
            depends_on: ['l1-interface', 'l2-rpc-init-wait-for-l1'],
            env_file: [`${networkEnvDir}/l2reth.env`],
            image: 'scrolltech/rollup-node:v0.0.1-rc63',
          },
        },
        volumes: {
          celestia_data: null,
          l1_interface_data: null,
          l2geth_data: null,
        },
      }),
    )

    fs.writeFileSync(
      path.join(valuesDir, 'l1-interface-production.yaml'),
      yaml.dump({
        initContainers: {
          'fetch-sqlite': {
            command: [
              '/bin/sh',
              '-c',
              'echo "$ARTIFACT_URL" > /data/artifact-url.txt',
            ],
            env: [
              {
                name: 'ARTIFACT_URL',
                value: 'https://snapshots.example/artifact.sqlite',
              },
            ],
            image: 'curlimages/curl:8.20.0',
            securityContext: {
              runAsGroup: 0,
              runAsUser: 0,
            },
            volumeMounts: [
              {
                mountPath: '/data',
                name: 'data',
              },
            ],
          },
        },
      }),
    )

    const result = syncRpcPackageInitContainersToCompose(valuesDir, rpcPackageDir)
    expect(result.changed).to.equal(true)
    expect(result.initServices).to.include('l1-interface-init-fetch-sqlite')
    expect(result.removedServices).to.deep.equal(['l2-rpc-init-wait-for-l1', 'celestia-light-node', 'l2geth-node'])

    const compose = yaml.load(fs.readFileSync(path.join(rpcPackageDir, 'docker-compose.yml'), 'utf8')) as TestComposeFile
    const l1InitService = compose.services['l1-interface-init-fetch-sqlite'] as {
      environment: Record<string, string>
      image: string
      user: string
      volumes: string[]
    }
    const l1InterfaceService = compose.services['l1-interface'] as {
      depends_on: Record<string, { condition: string }>
    }
    const l2rethService = compose.services['l2reth-node'] as {
      depends_on: string[]
    }

    expect(compose.services).not.to.have.property('celestia-light-node')
    expect(compose.services).not.to.have.property('l2geth-node')
    expect(compose.services).not.to.have.property('l2-rpc-init-wait-for-l1')
    expect(compose.volumes).not.to.have.property('celestia_data')
    expect(compose.volumes).not.to.have.property('l2geth_data')
    expect(l1InterfaceService.depends_on).not.to.have.property('celestia-light-node')
    expect((compose.services['l1-interface'].volumes as string[])[0]).to.equal(`./configs/\${NETWORK}/l2reth-genesis.json:/app/genesis/genesis.json:ro`)
    expect(l1InitService.image).to.equal('curlimages/curl:8.20.0')
    expect(l1InitService.environment.ARTIFACT_URL).to.equal('https://snapshots.example/artifact.sqlite')
    expect(l1InitService.volumes).to.deep.equal([`\${DATA_ROOT:?DATA_ROOT must be set}/l1-interface:/data`])
    expect(l1InitService.user).to.equal('0:0')
    expect(l1InterfaceService.depends_on['l1-interface-init-fetch-sqlite'].condition).to.equal('service_completed_successfully')
    expect(l2rethService.depends_on).to.deep.equal(['l1-interface'])
  })

  it('removes stale l1-interface init services when values declare no initContainers', () => {
    const valuesDir = path.join(tmpDir, 'values')
    const rpcPackageDir = path.join(tmpDir, 'dogeos-rpc-package')
    fs.mkdirSync(valuesDir, { recursive: true })
    fs.mkdirSync(rpcPackageDir, { recursive: true })

    // Mainnet scenario: the compose file still carries the fetch-sqlite init
    // service generated for another network, but the current values have no
    // initContainers, so the sync must drop the service and its dependency.
    fs.writeFileSync(
      path.join(rpcPackageDir, 'docker-compose.yml'),
      yaml.dump({
        services: {
          'dogecoin-node': {
            image: 'dogeos69/dogecoin:1.14.9',
          },
          'l1-interface': {
            depends_on: {
              'dogecoin-node': { condition: 'service_started' },
              'l1-interface-init-fetch-sqlite': { condition: 'service_completed_successfully' },
            },
            image: 'dogeos69/l1-interface:0.2.0-rc.7',
            volumes: ['l1_interface_data:/data'],
          },
          'l1-interface-init-fetch-sqlite': {
            container_name: 'l1-interface-init-fetch-sqlite',
            environment: { ARTIFACT_URL: 'https://testnet-snapshots.example/artifact.sqlite' },
            image: 'curlimages/curl:8.20.0',
            volumes: ['l1_interface_data:/data'],
          },
          'l2reth-node': {
            depends_on: ['l1-interface'],
            env_file: [`${networkEnvDir}/l2reth.env`],
            image: 'scrolltech/rollup-node:v0.0.1-rc63',
          },
        },
        volumes: {
          l1_interface_data: null,
        },
      }),
    )

    fs.writeFileSync(
      path.join(valuesDir, 'l1-interface-production.yaml'),
      yaml.dump({
        configMaps: {
          env: {
            data: {
              DOGEOS_L1_INTERFACE_NETWORK_STR: 'mainnet',
            },
          },
        },
      }),
    )

    const result = syncRpcPackageInitContainersToCompose(valuesDir, rpcPackageDir)
    expect(result.changed).to.equal(true)
    expect(result.removedServices).to.include('l1-interface-init-fetch-sqlite')

    const compose = yaml.load(fs.readFileSync(path.join(rpcPackageDir, 'docker-compose.yml'), 'utf8')) as TestComposeFile
    const l1InterfaceService = compose.services['l1-interface'] as {
      depends_on: Record<string, { condition: string }>
    }

    expect(compose.services).not.to.have.property('l1-interface-init-fetch-sqlite')
    expect(l1InterfaceService.depends_on).not.to.have.property('l1-interface-init-fetch-sqlite')
    expect(l1InterfaceService.depends_on).to.have.property('dogecoin-node')
  })
})
