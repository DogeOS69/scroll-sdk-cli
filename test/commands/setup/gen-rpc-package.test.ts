import { expect } from 'chai'
import * as yaml from 'js-yaml'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import SetupGenRpcPackage, {
  convertPeersToExternalDomains,
  normalizeConfigMapEnvData,
  syncRpcPackageInitContainersToCompose,
} from '../../../src/commands/setup/gen-rpc-package.js'

interface CommandHarness {
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

  it('converts internal bootnode enodes to public p2p LoadBalancer domains', () => {
    const peers = convertPeersToExternalDomains(
      [
        'enode://abc@l2-bootnode-0:30303',
        'enode://def@l2-sequencer-1.default.svc.cluster.local:30303',
        'enode://ghi@external.example.com:30303',
      ],
      {
        'l2-bootnode-0-p2p': 'bootnode-0.example.com',
      },
    )

    expect(peers).to.deep.equal([
      'enode://abc@bootnode-0.example.com:30303',
      'enode://def@l2-sequencer-1.default.svc.cluster.local:30303',
      'enode://ghi@external.example.com:30303',
    ])
  })

  it('writes l2geth and l2reth env files from l2-rpc values YAML and public bootnode peers', () => {
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
      path.join(valuesDir, 'l1-interface-production.yaml'),
      yaml.dump({
        configMaps: {
          env: {
            data: {
              DOGEOS_L1_INTERFACE_INITIAL_SYSTEM_SIGNER: '0x1234567890123456789012345678901234567890',
            },
          },
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
        '',
      ].join('\n'),
    )

    const command = createCommandHarness()
    const result = command.generateL2NodeEnvFiles(
      {
        bootnode: {
          L2_GETH_PUBLIC_PEERS: ['enode://bootnode@l2-bootnode-0:30303'],
        },
      },
      {
        defaults: { dogecoinIndexerStartHeight: '14023282' },
        network: 'testnet',
      },
      rpcPackageDir,
      {
        'l2-bootnode-0-p2p': 'bootnode-0.example.com',
        'l2-sequencer-0-p2p': 'sequencer-0.example.com',
      },
      'default',
      valuesDir,
    )

    expect(result.hasUnresolvedExternalPeers).to.equal(false)

    const l2gethEnv = fs.readFileSync(path.join(rpcPackageDir, 'envs', 'testnet', 'l2geth.env'), 'utf8')
    expect(l2gethEnv).to.include('CHAIN_ID=6281971')
    expect(l2gethEnv).to.include('L2GETH_L1_ENDPOINT=http://l1-interface:8545')
    expect(l2gethEnv).to.include('L2GETH_DA_BLOB_BEACON_NODE=http://l1-interface:5052')
    expect(l2gethEnv).to.include('L2GETH_PEER_LIST=["enode://bootnode@bootnode-0.example.com:30303"]')
    expect(l2gethEnv).not.to.include('sequencer-0.example.com')
    expect(l2gethEnv).not.to.include('L2RETH_VALID_SIGNER')

    const l2rethEnv = fs.readFileSync(path.join(rpcPackageDir, 'envs', 'testnet', 'l2reth.env'), 'utf8')
    expect(l2rethEnv).to.include('L2GETH_PEER_LIST=["enode://bootnode@bootnode-0.example.com:30303"]')
    expect(l2rethEnv).to.include('L2RETH_DA_BLOB_BEACON_NODE=http://l1-interface:5052')
    expect(l2rethEnv).to.include('L2RETH_L1_ENDPOINT=http://l1-interface:8545')
    expect(l2rethEnv).to.include('L2RETH_VALID_SIGNER=0x1234567890123456789012345678901234567890')
    expect(l2rethEnv).not.to.include('CHAIN_ID=1')
    expect(l2rethEnv).not.to.include('L2GETH_L1_ENDPOINT=http://old-l1')
  })

  it('writes a credential-free l1-interface env, an example template, and a scaffolded local override', () => {
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

    const command = createCommandHarness()
    command.generateL1InterfaceEnvFile(valuesDir, rpcPackageDir, 'testnet')

    // Generated file: deterministic, non-secret config only.
    const env = fs.readFileSync(path.join(rpcPackageDir, 'envs', 'testnet', 'l1-interface.env'), 'utf8')
    expect(env).to.include('RUST_LOG=info')
    expect(env).to.include('DOGEOS_L1_INTERFACE_API_BIND_ADDRESS=0.0.0.0:8545')
    expect(env).to.include('DOGEOS_L1_INTERFACE_BEACON_API_LISTEN_ADDRESS=0.0.0.0:5052')
    expect(env).to.include('DOGEOS_L1_INTERFACE_CHAIN_ID=6281971')
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
    expect(env).not.to.include('SCROLL_MESSENGER_ADDRESS')
    // Full overwrite: nothing from the stale prior file survives.
    expect(env).not.to.include('# existing')
    expect(env).not.to.include('http://dogecoin-node:44555')

    // Tracked template: credential-free, deterministic, safe to commit.
    const example = fs.readFileSync(
      path.join(rpcPackageDir, 'envs', 'testnet', 'l1-interface.local.env.example'),
      'utf8',
    )
    expect(example).to.include('# L1 Interface Testnet — operator overrides (TEMPLATE)')
    expect(example).to.include('cp envs/testnet/l1-interface.local.env.example envs/testnet/l1-interface.local.env')
    expect(example).to.include('DOGEOS_L1_INTERFACE_ETHEREUM_DA__L1_RPC_URL=https://your-ethereum-l1-rpc:8545')
    expect(example).not.to.include('cluster-dogecoin')
    expect(example).not.to.include('cluster-user')
    expect(example).not.to.include('do-not-copy')

    // Local override is scaffolded for the operator to fill in.
    expect(fs.existsSync(path.join(rpcPackageDir, 'envs', 'testnet', 'l1-interface.local.env'))).to.equal(true)
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
              'l1_interface_data:/data',
            ],
          },
          'l2geth-node': {
            depends_on: ['l1-interface'],
            env_file: ['./envs/common/l2geth.env', `${networkEnvDir}/l2geth.env`],
            image: 'scrolltech/l2geth:scroll-v5.9.6',
          },
          'l2reth-node': {
            depends_on: ['l1-interface'],
            image: 'scrolltech/rollup-node:v0.0.1-rc63',
          },
        },
        volumes: {
          celestia_data: null,
          l1_interface_data: null,
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

    fs.writeFileSync(
      path.join(valuesDir, 'l2-rpc-production.yaml'),
      yaml.dump({
        initContainers: {
          '1-wait-for-l1': {
            command: ['/bin/sh', '-c', '/wait-for-l1.sh $L2GETH_L1_ENDPOINT'],
            image: 'scrolltech/scroll-alpine:v0.0.1',
          },
        },
      }),
    )

    const result = syncRpcPackageInitContainersToCompose(valuesDir, rpcPackageDir)
    expect(result.changed).to.equal(true)
    expect(result.initServices).to.include('l1-interface-init-fetch-sqlite')
    expect(result.initServices).to.include('l2-rpc-init-wait-for-l1')
    expect(result.removedServices).to.deep.equal(['celestia-light-node'])

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
    const l2RpcWaitService = compose.services['l2-rpc-init-wait-for-l1'] as {
      command: string[]
      image: string
    }
    const l2gethService = compose.services['l2geth-node'] as {
      depends_on: Record<string, { condition: string }>
    }
    const l2rethService = compose.services['l2reth-node'] as {
      depends_on: Record<string, { condition: string }>
    }

    expect(compose.services).not.to.have.property('celestia-light-node')
    expect(compose.volumes).not.to.have.property('celestia_data')
    expect(l1InterfaceService.depends_on).not.to.have.property('celestia-light-node')
    expect(l1InitService.image).to.equal('curlimages/curl:8.20.0')
    expect(l1InitService.environment.ARTIFACT_URL).to.equal('https://snapshots.example/artifact.sqlite')
    expect(l1InitService.volumes).to.deep.equal(['l1_interface_data:/data'])
    expect(l1InitService.user).to.equal('0:0')
    expect(l1InterfaceService.depends_on['l1-interface-init-fetch-sqlite'].condition).to.equal('service_completed_successfully')
    expect(l2RpcWaitService.image).to.equal('curlimages/curl:8.20.0')
    expect(l2RpcWaitService.command[0]).to.include('eth_chainId')
    expect(l2gethService.depends_on['l2-rpc-init-wait-for-l1'].condition).to.equal('service_completed_successfully')
    expect(l2rethService.depends_on['l2-rpc-init-wait-for-l1'].condition).to.equal('service_completed_successfully')
  })
})
