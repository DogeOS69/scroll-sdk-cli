import { Command, Flags } from '@oclif/core'
import { execa } from 'execa'
import * as path from 'path'
import * as fs from 'fs/promises'
import toml from '@iarna/toml'

export default class LocalStackStart extends Command {
  static description = 'Start the DogeOS local stack (integrating components properly without Bash script issues)'

  static flags = {
    clean: Flags.boolean({ char: 'c', description: 'Clean existing containers before starting', default: true }),
    'clean-only': Flags.boolean({ description: 'Only clean existing environment and exit', default: false }),
    spec: Flags.string({ description: 'Path to deployment spec', default: 'src/config/deployment-spec.local.yaml' }),
    'core-path': Flags.string({ description: 'Path to dogeos-core directory', default: '../dogeos-core' }),
    'contracts-path': Flags.string({ description: 'Path to scroll-contracts directory', default: '../scroll-contracts' })
  }

  // --- Configuration ---
  private L2GETH_IMAGE = "scrolltech/l2geth:scroll-v5.9.6"
  private DOGECOIN_IMAGE = "dogeos69/dogecoin:latest"
  private SIGNER_ADDR = "0xa7CdA54170FFD9F9C7A6DC72f8a5E6E15ca32fA3"
  private ROLLUP_RELAYER_IMAGE = "scrolltech/rollup-relayer:v4.7.5"
  private ROLLUP_DB_CLI_IMAGE = "scrolltech/rollup-db-cli:v4.7.5"
  private TSO_IMAGE = "dogeos69/tso-service:0.2.0-rc.4"
  private DUMMY_SIGNER_IMAGE = "dogeos69/dummy-signer:0.2.0-rc.3"
  private DOCKER_NETWORK = "dogeos-net"
  private DOCKER_CMD = "docker" // Assume docker handles everything for now

  // Ports
  private L2_HTTP_PORT = 8546
  private L2_WS_PORT = 8547
  private L1_INTERFACE_PORT = 8548
  private DA_PUBLISHER_PORT = 3001
  private DOGECOIN_RPC_PORT = 18445
  private POSTGRES_PORT = 5432
  private WITHDRAWAL_PROCESSOR_PORT = 3002
  private TSO_PORT = 3003
  private DUMMY_SIGNER_PORT = 4000
  private DUMMY_CUBESIGNER_PORT = 4001
  private FEE_ORACLE_HEALTH_PORT = 8080

  async run(): Promise<void> {
    const { flags } = await this.parse(LocalStackStart)
    const scriptDir = path.resolve(this.config.root, 'local-stack')
    const projectDir = this.config.root
    const specPath = path.resolve(this.config.root, flags.spec)
    const dogeosCoreDir = path.resolve(this.config.root, flags['core-path'])
    const contractsDir = path.resolve(this.config.root, flags['contracts-path'])
    const dataDir = path.join(scriptDir, '.data')

    this.log('=== DogeOS Local Stack (TS Setup) ===')

    if (flags.clean || flags['clean-only']) {
      await this.cleanupExisting(scriptDir)
      if (flags['clean-only']) {
        this.log('Clean complete. Exiting.')
        return
      }
    }

    try {
      // 1. Initial config generation (so forge has config-contracts config.toml later)
      await this.regenerateServiceConfigs(specPath)

      // 2. Prepare forge config
      await this.prepareContractsVolumeConfig(scriptDir)

      // 3. Generate addresses
      await this.generateContractAddresses(scriptDir)

      // 4. Regenerate after contract deployment
      await this.regenerateServiceConfigs(specPath, path.join(scriptDir, 'contracts-volume', 'config-contracts.toml'))

      // 5. Start infrastructure (Celestia, Dogecoin, Postgres)
      await this.startCelestia(scriptDir)

      await this.startDogecoin(scriptDir)
      await this.waitForDogecoin()
      await this.startDogecoinMining()

      await this.startPostgres(scriptDir)

      // Unified Bridge Setup
      await this.setupBridge(dogeosCoreDir, dataDir, scriptDir, specPath)

      // Start L1 Interface
      await this.startL1Interface(scriptDir, projectDir, dogeosCoreDir)
      await this.waitForRpc(`http://localhost:${this.L1_INTERFACE_PORT}`, 'l1-interface')

      // L2 geth
      await this.initL2Geth(scriptDir)
      await this.startL2Geth(scriptDir)
      await this.waitForRpc(`http://localhost:${this.L2_HTTP_PORT}`, 'L2 geth')

      // da-publisher (L2 blobs -> Celestia)
      await this.startDaPublisher(scriptDir, projectDir, dogeosCoreDir)
      await this.delay(1000)

      // 6. Deploy L2 contracts
      const markerFile = path.join(scriptDir, '.l2-contracts-deployed')
      if (!await this.fileExists(markerFile)) {
        this.log('Deploying L2 contracts')
        await this.deployL2Contracts(scriptDir)
        await fs.writeFile(markerFile, '')
      } else {
        this.log('L2 contracts already deployed (marker file exists)')
      }

      // Fund service accounts and whitelist
      await this.setupL2Accounts()

      // L2 tx generator
      await this.startL2Txgen(scriptDir)
      await this.delay(3000)

      // Rollup database & services
      await this.createServiceDatabases()
      await this.migrateRollupDatabases(scriptDir)
      await this.startRollupRelayer(scriptDir)

      // TSO & Signers
      await this.startTso(scriptDir, dogeosCoreDir)
      await this.delay(2000)
      await this.startDummySigners(scriptDir, dogeosCoreDir)
      await this.startDummyCubesigner(scriptDir, dogeosCoreDir)

      // DogeOS native
      await this.startFeeOracle(scriptDir, projectDir, dogeosCoreDir)
      await this.regenerateWithdrawalProcessorConfig(specPath, scriptDir)
      await this.startWithdrawalProcessor(scriptDir, projectDir, dogeosCoreDir)

      // Disable genesis hold on L1 interface
      this.log('Disabling genesis hold on L1 interface...')
      try {
        await fetch('http://localhost:9091/disable-genesis-hold', { method: 'POST' })
      } catch (err: any) {
        this.log(`Warning: Failed to disable genesis hold: ${err.message}`)
      }

      await this.showStatus(scriptDir)
    } catch (err: any) {
      this.error(`Failed to start stack: ${err.message}`)
    }
  }

  // --- Helpers ---
  private async resolveBinaryPath(dogeosCoreDir: string, crateName: string): Promise<string | null> {
    const variations = [
      crateName,
      crateName.replace(/_/g, '-')
    ]
    const types = ['debug', 'release']

    for (const type of types) {
      for (const name of variations) {
        const binPath = path.join(dogeosCoreDir, 'target', type, name)
        if (await this.fileExists(binPath)) return binPath
      }
    }
    return null
  }
  private async ensureDir(dirPath: string) {
    await fs.mkdir(dirPath, { recursive: true }).catch(() => { })
  }

  private async fileExists(filePath: string): Promise<boolean> {
    try {
      await fs.access(filePath)
      return true
    } catch {
      return false
    }
  }

  private delay(ms: number) {
    return new Promise(r => setTimeout(r, ms))
  }

  private async dogeRpc(method: string, params: any[] = []): Promise<any> {
    const rpcAuth = Buffer.from('doge:doge_pass').toString('base64')
    try {
      const res = await fetch(`http://localhost:${this.DOGECOIN_RPC_PORT}/`, {
        method: 'POST',
        headers: {
          'Content-Type': 'text/plain',
          'Authorization': `Basic ${rpcAuth}`
        },
        body: JSON.stringify({ jsonrpc: '1.0', method, params, id: 1 })
      })
      if (!res.ok) {
        const text = await res.text()
        throw new Error(`RPC error: ${res.status} ${text}`)
      }
      const data = await res.json() as any
      if (data.error) {
        throw new Error(`Doge RPC Error (${method}): ${JSON.stringify(data.error)}`)
      }
      return data.result
    } catch (err: any) {
      throw new Error(`Doge RPC connection failed (${method}): ${err.message}`)
    }
  }

  private async waitForRpc(url: string, name: string, maxAttempts = 30) {
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ method: 'eth_blockNumber', params: [], id: 1, jsonrpc: '2.0' })
        })
        if (res.ok) {
          this.log(`${name} is ready`)
          return
        }
      } catch (e) {
        // keep trying
      }
      await this.delay(1000)
    }
    throw new Error(`${name} failed to start after ${maxAttempts}s`)
  }

  private async waitForDogecoin() {
    this.log('Waiting for Dogecoin RPC and Wallet...')
    for (let i = 0; i < 30; i++) {
      try {
        await this.dogeRpc('getblockchaininfo')
        // Also check if any wallet is loaded
        const wallets = await this.dogeRpc('listwallets').catch(() => [])
        if (wallets.length === 0) {
          this.log('No wallet loaded, attempting to create default wallet...')
          await this.dogeRpc('createwallet', ['wallet']).catch(() => { })
        }
        this.log('Dogecoin node and wallet are ready')
        return
      } catch (e) { }
      await this.delay(2000)
    }
  }

  // --- Main Steps ---
  private async cleanupExisting(scriptDir: string) {
    this.log('Cleaning up existing local stack environment...')

    // 1. Kill background processes (if .pid files exist)
    const pids = [
      'l1-interface.pid', 'da-publisher.pid', 'dogecoin-miner.pid',
      'l2-txgen.pid', 'withdrawal-processor.pid', 'fee-oracle.pid',
      'tso.pid', 'dummy-signer.pid', 'dummy-cubesigner.pid'
    ]
    for (const p of pids) {
      const pFile = path.join(scriptDir, p)
      if (await this.fileExists(pFile)) {
        try {
          const pidStr = await fs.readFile(pFile, 'utf8')
          const pid = parseInt(pidStr.trim(), 10)
          if (!isNaN(pid)) {
            process.kill(pid, 'SIGKILL')
          }
        } catch { }
        await fs.rm(pFile, { force: true }).catch(() => { })
      }
    }

    // 1b. Force kill by ports (more reliable for zombie processes)
    const ports = [
      this.L1_INTERFACE_PORT, // 8548
      3500, 9091, // l1-interface beacon and health
      this.DA_PUBLISHER_PORT, // 3001
      3000, // da-publisher listen port
      this.WITHDRAWAL_PROCESSOR_PORT, // 3002
      this.TSO_PORT,          // 3003
      this.DUMMY_SIGNER_PORT, // 4000
      this.DUMMY_CUBESIGNER_PORT, // 4001
      this.L2_HTTP_PORT,      // 8546
      this.L2_WS_PORT,        // 8547
      this.DOGECOIN_RPC_PORT, // 18445
      this.POSTGRES_PORT,     // 5432
      26657, 26658, 9090      // Celestia
    ]

    this.log(`Force cleaning ports: ${ports.join(', ')}...`)
    for (const port of ports) {
      try {
        await execa('fuser', ['-k', `${port}/tcp`]).catch(() => { })
      } catch { }
    }

    // 2. Kill Docker containers
    const containers = [
      'dogeos-l2geth', 'dogeos-dogecoin', 'dogeos-postgres', 'dogeos-rollup-relayer',
      'dogeos-celestia', 'dogeos-tso', 'dummy-signer-0'
    ]
    for (const c of containers) {
      await execa(this.DOCKER_CMD, ['rm', '-f', c]).catch(() => { })
    }

    // 3. Remove state files and directories (using Docker to remove root-owned files)
    await execa(this.DOCKER_CMD, ['run', '--rm', '-v', `${scriptDir}:/mnt`, 'alpine', 'sh', '-c', 'rm -rf /mnt/dogecoin-data /mnt/l2geth-data /mnt/data /mnt/l1_interface.sqlite* /mnt/dogeos-withdrawal-processor.sqlite* /mnt/dogeos-fee-oracle.sqlite* /mnt/fee_oracle.db* /mnt/.l2-contracts-deployed /mnt/*.log /mnt/*.pid /mnt/.data']).catch(() => {
      // fallback to fs.rm if sudo isn't available or needed
      return Promise.all([
        fs.rm(path.join(scriptDir, 'dogecoin-data'), { recursive: true, force: true }).catch(() => { }),
        fs.rm(path.join(scriptDir, 'l2geth-data'), { recursive: true, force: true }).catch(() => { }),
        fs.rm(path.join(scriptDir, 'data'), { recursive: true, force: true }).catch(() => { }),
        fs.rm(path.join(scriptDir, 'l1_interface.sqlite'), { force: true }).catch(() => { }),
        fs.rm(path.join(scriptDir, 'l1_interface.sqlite-shm'), { force: true }).catch(() => { }),
        fs.rm(path.join(scriptDir, 'l1_interface.sqlite-wal'), { force: true }).catch(() => { }),
        fs.rm(path.join(scriptDir, '.l2-contracts-deployed'), { force: true }).catch(() => { }),
        fs.rm(path.join(scriptDir, '.data', 'dogeos-withdrawal-processor.sqlite'), { force: true }).catch(() => { }),
        fs.rm(path.join(scriptDir, '.data', 'dogeos-withdrawal-processor.sqlite-shm'), { force: true }).catch(() => { }),
        fs.rm(path.join(scriptDir, '.data', 'dogeos-withdrawal-processor.sqlite-wal'), { force: true }).catch(() => { }),
        fs.rm(path.join(scriptDir, 'dogeos-withdrawal-processor.sqlite'), { force: true }).catch(() => { }),
        fs.rm(path.join(scriptDir, 'dogeos-withdrawal-processor.sqlite-shm'), { force: true }).catch(() => { }),
        fs.rm(path.join(scriptDir, 'dogeos-withdrawal-processor.sqlite-wal'), { force: true }).catch(() => { }),
        fs.rm(path.join(scriptDir, 'dogeos-fee-oracle.sqlite'), { force: true }).catch(() => { }),
        fs.rm(path.join(scriptDir, 'dogeos-fee-oracle.sqlite-shm'), { force: true }).catch(() => { }),
        fs.rm(path.join(scriptDir, 'dogeos-fee-oracle.sqlite-wal'), { force: true }).catch(() => { }),
        fs.rm(path.join(scriptDir, 'fee_oracle.db'), { force: true }).catch(() => { }),
        fs.rm(path.join(scriptDir, 'fee_oracle.db-shm'), { force: true }).catch(() => { }),
        fs.rm(path.join(scriptDir, 'fee_oracle.db-wal'), { force: true }).catch(() => { }),
        fs.rm(path.join(scriptDir, '.data'), { recursive: true, force: true }).catch(() => { })
      ])
    })

    await execa(this.DOCKER_CMD, ['network', 'create', this.DOCKER_NETWORK]).catch(() => { })
  }

  private async regenerateServiceConfigs(specPath: string, contractsToml?: string) {
    this.log('Regenerating service configs from deployment spec...')
    const runBinary = path.join(this.config.root, 'bin/run.js')
    const outputDir = path.join(this.config.root, 'local-stack')
    const args = [runBinary, 'setup', 'generate-from-spec', '--spec', specPath, '-f', '--config-only', '-o', outputDir]
    if (contractsToml) {
      args.push('-c', contractsToml)
    }
    await execa('node', args, { stdio: 'inherit' }).catch(() => {
      this.warn('Config regeneration failed - falling back to existing configs')
    })
  }

  private async prepareContractsVolumeConfig(scriptDir: string) {
    const projectDir = this.config.root
    await this.ensureDir(path.join(scriptDir, 'contracts-volume'))
    const sourceConfig = path.join(projectDir, 'config.toml')
    const destConfig = path.join(scriptDir, 'contracts-volume', 'config.toml')

    if (!await this.fileExists(sourceConfig)) throw new Error(`config.toml not found.`)

    await fs.copyFile(sourceConfig, destConfig)

    let content = await fs.readFile(destConfig, 'utf8')
    if (!content.includes('[sequencer]')) {
      content += `
[sequencer]
L2GETH_SIGNER_ADDRESS = "${this.SIGNER_ADDR}"
L2GETH_KEYSTORE = ""
L2GETH_PASSWORD = ""
L2GETH_NODEKEY = ""
L2_GETH_STATIC_PEERS = []
`
      await fs.writeFile(destConfig, content)
    }
  }

  private async generateContractAddresses(scriptDir: string) {
    this.log('Generating deterministic contract addresses (no RPC needed)...')
    await execa(this.DOCKER_CMD, [
      'run', '--rm', '--platform', 'linux/amd64', '--entrypoint=/bin/sh',
      '-e', 'DEPLOYER_PRIVATE_KEY=0x76273b5b6fc7eb6e931ee8f1e74a88d1fdd7ae225a4c8a664858b4cccb083827',
      '-e', 'L1_COMMIT_SENDER_PRIVATE_KEY=0x3f37a3239c8c909c23f6a2ec01c9c26485b9d2a2cd47b089876d2be5c38f328f',
      '-e', 'L1_FINALIZE_SENDER_PRIVATE_KEY=0x8a6d51138c05463e0c9b4501f5bb99d4774aa5ddeb46042832ac4e38aef02fdc',
      '-e', 'L1_GAS_ORACLE_SENDER_PRIVATE_KEY=0x1805b8b581a4710cf29881fb3eb80ceaf1d5a395a5ace8012d01953a2c1795db',
      '-e', 'L2_GAS_ORACLE_SENDER_PRIVATE_KEY=0x96cba5a694704477d6186aebc79a7ff50ba7ed95caacfe62a085a2d78be57597',
      '-v', `${scriptDir}/contracts-volume:/contracts/volume`,
      '-v', `${scriptDir}/generate-addresses.sh:/contracts/docker/scripts/local-deploy.sh`,
      'dogeos69/scroll-stack-contracts:deploy-20251010',
      '/contracts/docker/scripts/local-deploy.sh'
    ], { stdio: 'inherit' })

    const generated = path.join(scriptDir, 'contracts-volume', 'config-contracts.toml')
    await fs.copyFile(generated, path.join(this.config.root, 'config-contracts.toml'))
  }

  // L1 Node
  private async startDogecoin(scriptDir: string) {
    this.log(`Starting Dogecoin regtest node (v1.14.9) on port ${this.DOGECOIN_RPC_PORT}...`)
    await this.ensureDir(path.join(scriptDir, 'dogecoin-data'))

    await execa(this.DOCKER_CMD, [
      'run', '-d', '--name', 'dogeos-dogecoin', '--platform', 'linux/amd64', '--entrypoint=',
      '--network', this.DOCKER_NETWORK,
      '-v', `${scriptDir}/dogecoin-data:/data`,
      '-p', `${this.DOGECOIN_RPC_PORT}:44555`,
      this.DOGECOIN_IMAGE,
      '/dogecoin/bin/dogecoind',
      '-regtest', '-datadir=/data', '-server=1', '-txindex=1',
      '-rpcuser=doge', '-rpcpassword=doge_pass',
      '-rpcport=44555', '-rpcbind=0.0.0.0', '-rpcallowip=0.0.0.0/0',
      '-printtoconsole=1', '-maxconnections=0', '-listen=0'
    ])
  }

  private async startDogecoinMining() {
    this.log('Mining initial 110 blocks...')
    await this.dogeRpc('generate', [110])

    this.log('Starting auto-miner (1 block / 10s)...')
    const minerProcess = execa('node', ['-e', `
      setInterval(() => {
        fetch('http://localhost:${this.DOGECOIN_RPC_PORT}/', {
          method: 'POST',
          headers: {
            'Content-Type': 'text/plain',
            'Authorization': 'Basic ' + Buffer.from('doge:doge_pass').toString('base64')
          },
          body: JSON.stringify({ jsonrpc: '1.0', method: 'generate', params: [1], id: 1 })
        }).catch(()=>{});
      }, 10000);
    `], { detached: true, stdio: 'ignore' })
    minerProcess.unref()
    await fs.writeFile(path.join(this.config.root, 'local-stack', 'dogecoin-miner.pid'), String(minerProcess.pid))
  }

  private async startPostgres(scriptDir: string) {
    this.log(`Starting PostgreSQL on port ${this.POSTGRES_PORT}...`)
    await execa(this.DOCKER_CMD, [
      'run', '-d', '--name', 'dogeos-postgres',
      '--network', this.DOCKER_NETWORK,
      '-p', `${this.POSTGRES_PORT}:5432`,
      '-e', 'POSTGRES_USER=rollup_node',
      '-e', 'POSTGRES_PASSWORD=localdev',
      '-e', 'POSTGRES_DB=scroll_rollup',
      '-e', 'POSTGRES_HOST_AUTH_METHOD=trust',
      'postgres:16-alpine'
    ])

    for (let i = 0; i < 30; i++) {
      try {
        await execa(this.DOCKER_CMD, ['exec', 'dogeos-postgres', 'pg_isready', '-U', 'rollup_node'])
        this.log('PostgreSQL is ready')
        return
      } catch (e) {
        await this.delay(1000)
      }
    }
  }

  private async setupBridge(dogeosCoreDir: string, dataDir: string, scriptDir: string, specPath: string) {
    this.log('=== Setting up Bridge (Funding + Keys + Initialization) ===')

    // 1. Get helper address (dry run)
    let helperAddr = ''
    try {
      const { stdout } = await this.runGenerateTestKeys(dogeosCoreDir, dataDir, true)
      const match = stdout.match(/Distribution Helper Address \(derived from seed\):\s+(.+)/)
      if (match) helperAddr = match[1].trim()
    } catch (e: any) {
      const match = e.stdout?.match(/Distribution Helper Address \(derived from seed\):\s+(.+)/) ||
        e.stderr?.match(/Distribution Helper Address \(derived from seed\):\s+(.+)/)
      if (match) helperAddr = match[1].trim()
    }

    if (!helperAddr) throw new Error("Failed to get helper address from dogeos-core")
    this.log(`Bridge Helper Address: ${helperAddr}`)

    // 2. Check for existing UTXOs or fund
    let utxo: { txid: string; vout: number; amount_sats: number } | null = null
    try {
      const unspent = await this.dogeRpc('listunspent', [0, 9999999, [helperAddr]])
      if (unspent && unspent.length > 0) {
        const suitable = unspent.find((u: any) => u.amount >= 50)
        if (suitable) {
          utxo = { txid: suitable.txid, vout: suitable.vout, amount_sats: Math.floor(suitable.amount * 100000000) }
          this.log(`Found existing usable UTXO: ${utxo.txid}:${utxo.vout}`)
        }
      }
    } catch (e: any) {
      this.warn(`Failed to list unspent for ${helperAddr}: ${e.message}`)
    }

    if (!utxo) {
      this.log(`No suitable UTXO found for ${helperAddr}. Funding from node wallet...`)
      const txid = await this.dogeRpc('sendtoaddress', [helperAddr, 70])
      if (!txid) throw new Error('Failed to send DOGE to helper address')
      this.log(`Funding transaction sent: ${txid}. Mining 1 block to confirm...`)
      await this.dogeRpc('generatetoaddress', [1, helperAddr])

      const rawTx = await this.dogeRpc('getrawtransaction', [txid, true])
      let targetVout = -1
      let targetSats = -1
      for (const vout of rawTx.vout) {
        if (vout.scriptPubKey?.addresses?.includes(helperAddr) || vout.scriptPubKey?.address === helperAddr) {
          targetVout = vout.n
          targetSats = Math.floor(vout.value * 100000000)
          break
        }
      }
      if (targetVout === -1) throw new Error('Could not find valid vout for helper address.')
      utxo = { txid, vout: targetVout, amount_sats: targetSats }
    }

    // 3. Update spec and sync configs
    await this.updateDeploymentSpecUtxo(specPath, utxo)
    await this.regenerateServiceConfigs(specPath, path.join(scriptDir, 'contracts-volume', 'config-contracts.toml'))

    // 4. Main Key Generation Run
    this.log('Executing main generate_test_keys run...')
    await this.runGenerateTestKeys(dogeosCoreDir, dataDir)

    // 5. Copy generated outputs to .data
    const generatedOutputs = ['output-dummy-signer-keys.json', 'output-test-data.json', 'output-withdrawal-processor.toml']
    for (const file of generatedOutputs) {
      const src = path.join(dogeosCoreDir, file)
      const dest = path.join(dataDir, file)
      if (await this.fileExists(src)) await fs.copyFile(src, dest)
    }

    // 6. Inject addresses into l1-interface.toml
    const testDataFile = path.join(dataDir, 'output-test-data.json')
    if (await this.fileExists(testDataFile)) {
      const testData = JSON.parse(await fs.readFile(testDataFile, 'utf8'))
      const l1ConfigPath = path.join(dataDir, 'l1-interface.toml')
      if (await this.fileExists(l1ConfigPath)) {
        const configObj = toml.parse(await fs.readFile(l1ConfigPath, 'utf8')) as any
        if (configObj.dogecoin_indexer) {
          configObj.dogecoin_indexer.bridge_address = testData.bridge_address
          configObj.dogecoin_indexer.fee_wallet_address = testData.fee_wallet_address
          configObj.dogecoin_indexer.sequencer_address = testData.sequencer_address
        }
        await fs.writeFile(l1ConfigPath, toml.stringify(JSON.parse(JSON.stringify(configObj))))
        this.log('Successfully injected addresses into l1-interface.toml.')
      }
    }

    // 7. Import wallets
    await this.importWallets(dataDir, dogeosCoreDir)
  }

  private async startL1Interface(scriptDir: string, projectDir: string, dogeosCoreDir: string) {
    const binary = await this.resolveBinaryPath(dogeosCoreDir, 'l1_interface')
    let config = path.join(scriptDir, '.data/l1-interface.toml')
    if (!await this.fileExists(config)) config = path.join(scriptDir, 'l1-interface.toml')

    if (!binary) {
      throw new Error(`l1-interface binary not found. Build it: cargo build -p l1_interface`)
    }

    this.log(`Starting l1-interface on port ${this.L1_INTERFACE_PORT}...`)
    const logFile = await fs.open(path.join(scriptDir, 'l1-interface.log'), 'a')
    const subprocess = (execa as any)(binary, ['-c', config], {
      cwd: scriptDir,
      env: { RUST_LOG: 'info' },
      detached: true,
      stdio: ['ignore', logFile.fd, logFile.fd]
    })
    subprocess.unref()
    // It spawns as a background process so we just write pid
    await fs.writeFile(path.join(scriptDir, 'l1-interface.pid'), String(subprocess.pid))
  }

  private async initL2Geth(scriptDir: string) {
    this.log("Initializing L2 geth data directory...")
    const l2gethDataDir = path.join(scriptDir, 'l2geth-data')

    // Ensure the directory exists because cleanupExisting might have removed it entirely
    await this.ensureDir(l2gethDataDir)

    // Write the password and keystore FIRST, before Docker runs as root
    // and potentially changes the ownership of the directory.
    await fs.writeFile(path.join(scriptDir, 'password'), 'P99taya6bf8bV9oNhVz9')
    await this.ensureDir(path.join(l2gethDataDir, 'keystore'))
    const keystore = `{"address":"a7cda54170ffd9f9c7a6dc72f8a5e6e15ca32fa3","id":"605cd701-66fc-41ea-85c5-d1a4a14f8172","version":3,"crypto":{"cipher":"aes-128-ctr","cipherparams":{"iv":"1ae69a3f82a547efbb7db94150ccd907"},"ciphertext":"66f205470186c17bbeed8078dceabe70f270115c60dd3361fdaeba3b1863d9b4","kdf":"scrypt","kdfparams":{"salt":"ec79e5d4ac41fa9443b566a5d2e75806f7f61e9b80d0c91112432d0e5e6de731","n":131072,"dklen":32,"p":1,"r":8},"mac":"8ea486830bf257d1933ab53e397f72fb22a0a2443e72f49da7f0768007912bb7"}}`
    await fs.writeFile(path.join(l2gethDataDir, 'keystore/UTC--2025-10-23T21-11-35.0Z--a7cda54170ffd9f9c7a6dc72f8a5e6e15ca32fa3'), keystore)

    // Running geth init. It will populate chaindata, lightchaindata, etc. natively.
    await execa(this.DOCKER_CMD, ['run', '--rm', '--platform', 'linux/amd64', '--entrypoint=',
      '-v', `${l2gethDataDir}:/l2geth/data`,
      '-v', `${scriptDir}/genesis.json:/l2geth/genesis.json:ro`,
      this.L2GETH_IMAGE, 'geth', '--datadir', '/l2geth/data', 'init', '/l2geth/genesis.json'])
  }

  private async startL2Geth(scriptDir: string) {
    const l1_endpoint = `http://host.docker.internal:${this.L1_INTERFACE_PORT}`
    this.log(`Starting L2 geth on ports ${this.L2_HTTP_PORT}/${this.L2_WS_PORT}...`)
    await execa(this.DOCKER_CMD, [
      'run', '-d', '--name', 'dogeos-l2geth', '--platform', 'linux/amd64', '--entrypoint=',
      '--network', this.DOCKER_NETWORK,
      '--add-host', 'host.docker.internal:host-gateway',
      '-v', `${scriptDir}/l2geth-data:/l2geth/data`,
      '-v', `${scriptDir}/password:/l2geth/password:ro`,
      '-p', `${this.L2_HTTP_PORT}:8545`,
      '-p', `${this.L2_WS_PORT}:8546`,
      this.L2GETH_IMAGE,
      'geth', '--datadir', '/l2geth/data',
      '--networkid', '221122', '--port', '30303', '--nodiscover', '--syncmode', 'full',
      '--http', '--http.port', '8545', '--http.addr', '0.0.0.0', '--http.vhosts=*', '--http.corsdomain', '*',
      '--http.api', 'eth,scroll,net,web3,debug',
      '--ws', '--ws.port', '8546', '--ws.addr', '0.0.0.0', '--ws.api', 'eth,scroll,net,web3,debug',
      '--unlock', this.SIGNER_ADDR, '--password', '/l2geth/password', '--allow-insecure-unlock', '--mine',
      '--gcmode', 'archive',
      '--cache.noprefetch', '--cache.snapshot=0', '--snapshot=false',
      '--miner.gasprice', '1000000', '--miner.gaslimit', '10000000', '--rpc.gascap', '0',
      '--l1.endpoint', l1_endpoint, '--l1.confirmations', '0x6', '--l1.sync.startblock', '0',
      '--l1.sync.fetchblockrange', '8', '--verbosity', '5', '--vmodule', 'rollup=5',
      '--rollup.verify',
      '--scroll-mpt',
      '--da.blob.beaconnode', 'http://host.docker.internal:3500', // default empty if beacon unavailable but passed to avoid CLI error usually
      '--gpo.maxprice', '500000000',
      '--gpo.ignoreprice', '1000000',
      '--gpo.percentile', '20',
      '--gpo.blocks', '100',
      '--txpool.globalqueue', '4096',
      '--txpool.accountqueue', '256',
      '--txpool.globalslots', '40960',
      '--txpool.accountslots', '128',
      '--metrics', '--metrics.expensive',
      '--gossip.enablebroadcasttoall'
    ])
  }

  private async startCelestia(scriptDir: string) {
    this.log('Building Celestia devnet image...')
    await execa(this.DOCKER_CMD, ['build', '-t', 'dogeos-celestia-devnet:latest', path.join(scriptDir, 'celestia-devnet')])
    this.log('Starting Celestia devnet (consensus + bridge)...')
    await execa(this.DOCKER_CMD, [
      'run', '-d', '--name', 'dogeos-celestia',
      '--network', this.DOCKER_NETWORK,
      '-p', '26657:26657', '-p', '26658:26658', '-p', '9090:9090',
      'dogeos-celestia-devnet:latest'
    ])

    for (let i = 0; i < 60; i++) {
      try {
        const res = await fetch('http://localhost:26658', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: 1, jsonrpc: '2.0', method: 'header.LocalHead', params: [] })
        })
        const data = await res.json() as any
        if (data.result?.header?.height) {
          this.log('Celestia bridge node is ready')
          return
        }
      } catch (e) { }
      await this.delay(2000)
    }
  }

  private async startDaPublisher(scriptDir: string, projectDir: string, dogeosCoreDir: string) {
    const binary = await this.resolveBinaryPath(dogeosCoreDir, 'da_publisher')
    let config = path.join(scriptDir, '.data/da-publisher.toml')
    if (!await this.fileExists(config)) config = path.join(scriptDir, 'da-publisher.toml')

    if (!binary) {
      throw new Error(`da-publisher binary not found. Build it: cargo build -p da_publisher`)
    }

    this.log(`Starting da-publisher on port ${this.DA_PUBLISHER_PORT}...`)
    const logFile = await fs.open(path.join(scriptDir, 'da-publisher.log'), 'a')
    const subprocess = (execa as any)(binary, ['-c', config], {
      cwd: scriptDir,
      env: { RUST_LOG: 'info' },
      detached: true,
      stdio: ['ignore', logFile.fd, logFile.fd]
    })
    subprocess.unref()
    await fs.writeFile(path.join(scriptDir, 'da-publisher.pid'), String(subprocess.pid))
  }

  private async deployL2Contracts(scriptDir: string) {
    await execa(this.DOCKER_CMD, [
      'run', '--rm', '--platform', 'linux/amd64', '--entrypoint=/bin/sh',
      '--network', this.DOCKER_NETWORK,
      '--add-host', 'host.docker.internal:host-gateway',
      '-e', `L2_RPC_ENDPOINT=http://host.docker.internal:${this.L2_HTTP_PORT}`,
      '-e', 'DEPLOYER_PRIVATE_KEY=0x76273b5b6fc7eb6e931ee8f1e74a88d1fdd7ae225a4c8a664858b4cccb083827',
      '-e', 'L1_COMMIT_SENDER_PRIVATE_KEY=0x3f37a3239c8c909c23f6a2ec01c9c26485b9d2a2cd47b089876d2be5c38f328f',
      '-e', 'L1_FINALIZE_SENDER_PRIVATE_KEY=0x8a6d51138c05463e0c9b4501f5bb99d4774aa5ddeb46042832ac4e38aef02fdc',
      '-e', 'L1_GAS_ORACLE_SENDER_PRIVATE_KEY=0x1805b8b581a4710cf29881fb3eb80ceaf1d5a395a5ace8012d01953a2c1795db',
      '-e', 'L2_GAS_ORACLE_SENDER_PRIVATE_KEY=0x96cba5a694704477d6186aebc79a7ff50ba7ed95caacfe62a085a2d78be57597',
      '-v', `${scriptDir}/contracts-volume:/contracts/volume`,
      '-v', `${scriptDir}/deploy-contracts.sh:/contracts/docker/scripts/local-deploy.sh`,
      'dogeos69/scroll-stack-contracts:deploy-20251010',
      '/contracts/docker/scripts/local-deploy.sh'
    ], { stdio: 'inherit' })
  }

  private async setupL2Accounts() {
    this.log('Setting up L2 accounts (funding fee-oracle sender, whitelisting)...')
    const cast = path.join(process.env.HOME || '', '.foundry/bin/cast')
    const rpc = `http://localhost:${this.L2_HTTP_PORT}`
    const key = `0x76273b5b6fc7eb6e931ee8f1e74a88d1fdd7ae225a4c8a664858b4cccb083827`
    const feeOracleAddr = `0x29E2f3B76662134404cEA5A8f12E0d4B6e6fdE5a`

    await execa(cast, ['send', '--rpc-url', rpc, '--private-key', key, '--value', '0.1ether', feeOracleAddr]).catch(() => { })
    await execa(cast, ['send', '--rpc-url', rpc, '--private-key', key, '0x5300000000000000000000000000000000000003', 'updateWhitelistStatus(address[],bool)', `[${feeOracleAddr}]`, 'true']).catch(() => { })
    await execa(cast, ['send', '--rpc-url', rpc, '--private-key', key, '0x5300000000000000000000000000000000000002', 'updateWhitelist(address)', '0x5300000000000000000000000000000000000003']).catch(() => { })
  }

  private async startL2Txgen(scriptDir: string) {
    this.log('Starting L2 tx generator...')
    const cast = path.join(process.env.HOME || '', '.foundry/bin/cast')
    const txGenProcess = execa('node', ['-e', `
      const { execSync } = require('child_process');
      setInterval(() => {
        try { execSync('${cast} send --rpc-url http://localhost:${this.L2_HTTP_PORT} --private-key 0x76273b5b6fc7eb6e931ee8f1e74a88d1fdd7ae225a4c8a664858b4cccb083827 --value 0 0x0000000000000000000000000000000000000001', {stdio:'ignore'}); } catch(e){}
      }, 5000)
    `], { detached: true, stdio: 'ignore' })
    txGenProcess.unref()
    await fs.writeFile(path.join(scriptDir, 'l2-txgen.pid'), String(txGenProcess.pid))
  }

  private async createServiceDatabases() {
    this.log('Creating service databases...')
    const dbs = ['bridge_history', 'gas_oracle', 'coordinator', 'chain_monitor', 'rollup_explorer', 'blockscout', 'admin_system']
    for (const db of dbs) {
      await execa(this.DOCKER_CMD, ['exec', 'dogeos-postgres', 'psql', '-U', 'rollup_node', '-d', 'scroll_rollup', '-c', `CREATE DATABASE ${db} OWNER rollup_node`]).catch(() => { })
    }
  }

  private async migrateRollupDatabases(scriptDir: string) {
    this.log('Running rollup DB migration...')
    await execa(this.DOCKER_CMD, [
      'run', '--rm', '--platform', 'linux/amd64', '--network', this.DOCKER_NETWORK,
      '-v', `${scriptDir}/migrate-rollup-db.json:/app/conf/config.json`,
      '-v', `${scriptDir}/genesis.json:/app/conf/genesis.json`,
      this.ROLLUP_DB_CLI_IMAGE,
      '--genesis', '/app/conf/genesis.json', 'migrate', '--config', '/app/conf/config.json'
    ], { stdio: 'inherit' }).catch(() => this.warn('Rollup DB migration failed.'))
  }

  private async startRollupRelayer(scriptDir: string) {
    this.log('Starting rollup-relayer...')
    await execa(this.DOCKER_CMD, [
      'run', '-d', '--name', 'dogeos-rollup-relayer', '--platform', 'linux/amd64', '--network', this.DOCKER_NETWORK,
      '--add-host', 'host.docker.internal:host-gateway',
      '-v', `${scriptDir}/rollup-config.json:/app/conf/rollup-config.json`,
      '-v', `${scriptDir}/genesis.json:/app/genesis/genesis.json`,
      '--entrypoint=', this.ROLLUP_RELAYER_IMAGE,
      'rollup_relayer', '--config', '/app/conf/rollup-config.json', '--genesis', '/app/genesis/genesis.json', '--min-codec-version', '7', '--verbosity', '3'
    ])
  }

  private async startTso(scriptDir: string, dogeosCoreDir: string) {
    const binary = path.join(dogeosCoreDir, 'target/debug/tso_service')
    if (!await this.fileExists(binary)) {
      this.warn(`tso_service binary not found at ${binary}, skipping...`)
      return
    }
    this.log(`Starting TSO on port ${this.TSO_PORT}...`)
    const logFile = await fs.open(path.join(scriptDir, 'tso.log'), 'a')
    const subprocess = (execa as any)(binary, [], {
      cwd: scriptDir,
      env: {
        RUST_LOG: 'info',
        PORT: String(this.TSO_PORT),
        DOGE_NETWORK: 'regtest',
        WITHDRAWAL_PROCESSOR_URL: `http://127.0.0.1:${this.WITHDRAWAL_PROCESSOR_PORT}`
      },
      detached: true,
      stdio: ['ignore', logFile.fd, logFile.fd]
    })
    subprocess.unref()
    await fs.writeFile(path.join(scriptDir, 'tso.pid'), String(subprocess.pid))
  }

  private async startDummySigners(scriptDir: string, dogeosCoreDir: string) {
    const binary = await this.resolveBinaryPath(dogeosCoreDir, 'dummy_signer')
    if (!binary) {
      this.warn(`dummy_signer binary not found, skipping...`)
      return
    }
    let signerWif = ""
    const keysPath = path.join(scriptDir, '.data/output-dummy-signer-keys.json')
    if (await this.fileExists(keysPath)) {
      try {
        const keys = JSON.parse(await fs.readFile(keysPath, 'utf8'))
        const correctnessKey = keys.find((k: any) => k.role === 'Correctness')
        if (correctnessKey) {
          signerWif = correctnessKey.wif
        } else if (keys.length > 0) {
          signerWif = keys[0].wif
        }
      } catch (e) {
        this.warn('Failed to parse dummy signer keys, using fallback WIF')
      }
    }

    this.log(`Starting dummy signer with WIF: ${signerWif.substring(0, 5)}...`)
    const logFile = await fs.open(path.join(scriptDir, 'dummy-signer.log'), 'a')
    const subprocess = (execa as any)(binary, [], {
      cwd: scriptDir,
      env: {
        RUST_LOG: 'info',
        PORT: String(this.DUMMY_SIGNER_PORT),
        DUMMY_SIGNER_WIF: signerWif,
        DUMMY_SIGNER_NETWORK: 'regtest',
        DUMMY_SIGNER_TSO_URL: `http://127.0.0.1:${this.TSO_PORT}`
      },
      detached: true,
      stdio: ['ignore', logFile.fd, logFile.fd]
    })
    subprocess.unref()
    await fs.writeFile(path.join(scriptDir, 'dummy-signer.pid'), String(subprocess.pid))
  }

  private async startDummyCubesigner(scriptDir: string, dogeosCoreDir: string) {
    const binary = await this.resolveBinaryPath(dogeosCoreDir, 'dummy_cubesigner')
    if (!binary) {
      this.warn(`dummy_cubesigner binary not found in target/debug or target/release, skipping...`)
      return
    }

    let signerWif = "cVBFS2dW56VvaDppUnsP38unsddC8FdNDeYQLtG6U3GzvSq8rsuH" // Attestation fallback
    const keysPath = path.join(scriptDir, '.data/output-dummy-signer-keys.json')
    if (await this.fileExists(keysPath)) {
      try {
        const keys = JSON.parse(await fs.readFile(keysPath, 'utf8'))
        const attestationKey = keys.find((k: any) => k.role === 'Attestation')
        if (attestationKey) signerWif = attestationKey.wif
      } catch (e) {
        this.warn('Failed to parse attestation keys for cubesigner, using fallback')
      }
    }

    this.log(`Starting dummy cubesigner on port ${this.DUMMY_CUBESIGNER_PORT}...`)
    const logFile = await fs.open(path.join(scriptDir, 'dummy-cubesigner.log'), 'a')
    const subprocess = (execa as any)(binary, [
      '--network', 'regtest',
      '--port', String(this.DUMMY_CUBESIGNER_PORT),
      '--wif', signerWif,
      '--tso-url', `http://127.0.0.1:${this.TSO_PORT}`,
      '--signature-delay', '1'
    ], {
      cwd: scriptDir,
      env: { RUST_LOG: 'info' },
      detached: true,
      stdio: ['ignore', logFile.fd, logFile.fd]
    })
    subprocess.unref()
    await fs.writeFile(path.join(scriptDir, 'dummy-cubesigner.pid'), String(subprocess.pid))
  }

  private async regenerateWithdrawalProcessorConfig(specPath: string, scriptDir: string) {
    const bridgeOutput = path.join(scriptDir, '.data/output-withdrawal-processor.toml')
    const wpConfig = path.join(scriptDir, '.data/withdrawal-processor.toml')
    if (await this.fileExists(bridgeOutput) && await this.fileExists(wpConfig)) {
      const config = toml.parse(await fs.readFile(wpConfig, 'utf8')) as any
      const output = toml.parse(await fs.readFile(bridgeOutput, 'utf8')) as any

      // Regenerate if placeholders exist OR if there's a mismatch with the latest bridge output
      const needsRegen =
        config.bridge_address?.includes('2N1dummy') ||
        config.genesis_sequencer_txid !== output.genesis_sequencer_txid ||
        config.bridge_address !== output.bridge_address

      if (needsRegen) {
        this.log('Detected config mismatch/placeholders in withdrawal-processor, regenerating...')
        await this.regenerateServiceConfigs(specPath, path.join(scriptDir, 'contracts-volume', 'config-contracts.toml'))
      }

      // Always ensure tso_signers are present in the final config
      const updatedConfig = toml.parse(await fs.readFile(wpConfig, 'utf8')) as any
      if (!updatedConfig.tso_signers || updatedConfig.tso_signers.length === 0) {
        this.log('Injecting tso_signers into withdrawal-processor.toml...')
        updatedConfig.tso_signers = [
          {
            network: "regtest",
            uri: `http://127.0.0.1:${this.DUMMY_SIGNER_PORT}`, // 4000
            role: "Correctness"
          },
          {
            network: "regtest",
            uri: `http://127.0.0.1:${this.DUMMY_CUBESIGNER_PORT}`, // 4001
            role: "Attestation"
          }
        ]
        await fs.writeFile(wpConfig, toml.stringify(updatedConfig))
      }
    }
  }

  private async startFeeOracle(scriptDir: string, projectDir: string, dogeosCoreDir: string) {
    const binary = await this.resolveBinaryPath(dogeosCoreDir, 'fee_oracle')
    let config = path.join(scriptDir, '.data/fee-oracle.toml')
    if (!await this.fileExists(config)) config = path.join(scriptDir, 'fee-oracle.toml')
    if (binary) {
      this.log('Starting fee-oracle...')
      const logFile = await fs.open(path.join(scriptDir, 'fee-oracle.log'), 'a')
      const subprocess = (execa as any)(binary, ['-c', config], {
        cwd: scriptDir,
        env: { RUST_LOG: 'info', DOGEOS_FEE_ORACLE_PRIVATE_KEY: '0x96cba5a694704477d6186aebc79a7ff50ba7ed95caacfe62a085a2d78be57597' },
        detached: true,
        stdio: ['ignore', logFile.fd, logFile.fd]
      })
      subprocess.unref()
      await fs.writeFile(path.join(scriptDir, 'fee-oracle.pid'), String(subprocess.pid))
    }
  }

  private async startWithdrawalProcessor(scriptDir: string, projectDir: string, dogeosCoreDir: string) {
    const binary = await this.resolveBinaryPath(dogeosCoreDir, 'withdrawal_processor')
    let config = path.join(scriptDir, '.data/withdrawal-processor.toml')
    if (!await this.fileExists(config)) config = path.join(scriptDir, 'withdrawal-processor.toml')
    if (binary) {
      this.log('Starting withdrawal-processor...')
      const logFile = await fs.open(path.join(scriptDir, 'withdrawal-processor.log'), 'a')
      const subprocess = (execa as any)(binary, ['-c', config], {
        cwd: scriptDir,
        env: { RUST_LOG: 'info' },
        detached: true,
        stdio: ['ignore', logFile.fd, logFile.fd]
      })
      subprocess.unref()
      await fs.writeFile(path.join(scriptDir, 'withdrawal-processor.pid'), String(subprocess.pid))
    }
  }

  private async importWallets(dataDir: string, dogeosCoreDir: string) {
    this.log('Importing addresses to Dogecoin node using local wallet-import tool...')
    const testDataFile = path.join(dataDir, 'output-test-data.json')
    if (!await this.fileExists(testDataFile)) {
      this.warn('output-test-data.json not found, skipping wallet import')
      return
    }

    const testData = JSON.parse(await fs.readFile(testDataFile, 'utf8'))
    const { bridge_address, fee_wallet_address, sequencer_address } = testData

    if (!bridge_address || !fee_wallet_address || !sequencer_address) {
      this.warn('Incomplete bridge data in output-test-data.json, skipping wallet import')
      return
    }

    // Use local binary or cargo run
    const binary = path.join(dogeosCoreDir, 'target/debug/dogecoin_wallet_import')

    const rpcUrl = `http://localhost:${this.DOGECOIN_RPC_PORT}`
    const rpcUser = 'doge'
    const rpcPassword = 'doge_pass'

    this.log(`Importing: Bridge(${bridge_address}), Fee(${fee_wallet_address}), Sequencer(${sequencer_address})`)

    const args = [
      '--rpc-url', rpcUrl,
      '--rpc-user', rpcUser,
      '--rpc-password', rpcPassword,
      '--network', 'regtest',
      '--address', bridge_address,
      '--address', fee_wallet_address,
      '--address', sequencer_address,
      '--rescan',
      '--height', '0'
    ]

    if (await this.fileExists(binary)) {
      await execa(binary, args, { stdio: 'inherit' }).catch((e) => {
        this.warn(`Wallet import failed (binary): ${e.message}`)
      })
    } else {
      this.log('Binary not found, using cargo run -p dogecoin_wallet_import...')
      await execa('cargo', ['run', '-p', 'dogecoin_wallet_import', '--', ...args], {
        cwd: dogeosCoreDir,
        stdio: 'inherit'
      }).catch((e) => {
        this.warn(`Wallet import failed (cargo): ${e.message}`)
      })
    }
  }

  private async runGenerateTestKeys(dogeosCoreDir: string, dataDir: string, silent = false): Promise<any> {
    const src = path.join(dataDir, 'setup_defaults.toml')
    const dest = path.join(dogeosCoreDir, 'crates/test_utils/config/setup_defaults.toml')

    if (await this.fileExists(src)) {
      this.log(`Syncing setup_defaults.toml to ${dest}`)
      await fs.copyFile(src, dest)
    }

    const options: any = {
      cwd: dogeosCoreDir,
      stdio: silent ? 'pipe' : 'inherit'
    }

    try {
      return await execa('cargo', ['run', '-p', 'test_utils', '--bin', 'generate_test_keys'], options)
    } catch (e: any) {
      if (!silent) {
        this.log(`Warning: generate keys errored: ${e.message}`)
      }
      throw e
    }
  }

  private async showStatus(scriptDir: string) {
    this.log('\n=== Stack is running ===\n')
    this.log(`  Dogecoin:          http://localhost:${this.DOGECOIN_RPC_PORT}`)
    this.log(`  L2 geth:           http://localhost:${this.L2_HTTP_PORT}`)
    this.log(`  Celestia Bridge:   http://localhost:26658`)
    this.log(`  Celestia Node:     http://localhost:26657`)
    this.log('\nLogs:\n  docker logs dogeos-l2geth\n  docker logs dogeos-dogecoin\n  docker logs dogeos-celestia\n  docker logs dogeos-rollup-relayer')
  }


  private async updateDeploymentSpecUtxo(specPath: string, utxo: { txid: string; vout: number; amount_sats: number }) {
    let content = await fs.readFile(specPath, 'utf8')

    // Find if baseFundingUtxos already exists
    const pattern = /(baseFundingUtxos:\s*\n\s*-\s*txid:\s*")[^"]+("\s*\n\s*vout:\s*)\d+(\s*\n\s*amount_sats:\s*)\d+/g
    if (pattern.test(content)) {
      this.log('Updating existing baseFundingUtxos in spec...')
      const replacement = `$1${utxo.txid}$2${utxo.vout}$3${utxo.amount_sats}`
      content = content.replace(pattern, replacement)
    } else {
      this.log('Adding new baseFundingUtxos to spec under bridge section...')
      // Find the bridge: section and insert it
      const bridgeMatch = content.match(/bridge:/)
      if (bridgeMatch) {
        const insertPos = bridgeMatch.index! + bridgeMatch[0].length
        const insertion = `\n  baseFundingUtxos:\n    - txid: \"${utxo.txid}\"\n      vout: ${utxo.vout}\n      amount_sats: ${utxo.amount_sats}`
        content = content.slice(0, insertPos) + insertion + content.slice(insertPos)
      } else {
        this.warn('Could not find bridge: section in spec, skipping YAML update')
        return
      }
    }

    await fs.writeFile(specPath, content)
    this.log(`Deployment spec updated with UTXO ${utxo.txid}:${utxo.vout}`)
  }
}
