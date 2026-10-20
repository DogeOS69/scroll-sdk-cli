import Docker from 'dockerode'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** Isolated local startup probe: only public genesis is mounted; no P2P network, keys or persistent data. */
export async function checkRethStartup(image: string, genesis: string, docker = new Docker(), timeoutMs = 30_000): Promise<{imageId: string; status: 'started'}> {
  const file = fs.realpathSync(genesis)
  if (!fs.statSync(file).isFile() || path.basename(file).includes(':')) throw new Error('A regular genesis JSON file is required')
  const chain = JSON.parse(fs.readFileSync(file, 'utf8'))
  if (!Number.isSafeInteger(chain.config?.chainId)) throw new Error('Genesis requires a numeric chain ID')
  for (const selected of [image, 'node:22-alpine']) {
    try {await docker.getImage(selected).inspect()} catch {
      const stream = await docker.pull(selected)
      await new Promise<void>((resolve, reject) => {
        docker.modem.followProgress(stream, error => error ? reject(new Error('Cannot pull Reth startup probe images')) : resolve())
      })
    }
  }

  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'scrollsdk-reth-startup-'))
  const publicGenesis = path.join(temporary, 'genesis.json')
  fs.writeFileSync(publicGenesis, JSON.stringify(chain), {mode: 0o444})
  let container: Docker.Container | undefined
  let mock: Docker.Container | undefined
  try {
    // A public, deterministic read-only L1 fixture. Both containers share this
    // network-disabled namespace; neither can reach a cluster or real RPC.
    const fixture = `
      const http = require('node:http');
      const block = {
        hash: '0x' + '1'.repeat(64), parentHash: '0x' + '0'.repeat(64), number: '0x0',
        sha3Uncles: '0x' + '0'.repeat(64), miner: '0x' + '0'.repeat(40),
        stateRoot: '0x' + '0'.repeat(64), transactionsRoot: '0x' + '0'.repeat(64),
        receiptsRoot: '0x' + '0'.repeat(64), logsBloom: '0x' + '0'.repeat(512),
        difficulty: '0x0', totalDifficulty: '0x0', extraData: '0x', size: '0x0',
        gasLimit: '0x1c9c380', gasUsed: '0x0', timestamp: '0x' + Math.floor(Date.now() / 1000).toString(16),
        transactions: [], uncles: [], nonce: '0x0000000000000000', mixHash: '0x' + '0'.repeat(64), baseFeePerGas: '0x1'
      };
      const reply = request => {
        const result = ['eth_call', 'eth_getStorageAt'].includes(request.method) ? '0x' + '0'.repeat(63) + '1'
          : request.method === 'eth_chainId' ? '0xaa36a7'
          : request.method === 'eth_blockNumber' ? '0x0'
          : request.method === 'eth_getLogs' ? []
          : request.method === 'eth_getBlockByNumber' || request.method === 'eth_getBlockByHash' ? block : null;
        return {jsonrpc: '2.0', id: request.id, result};
      };
      http.createServer((request, response) => {
        let body = ''; request.on('data', chunk => body += chunk);
        request.on('end', () => {
          try {const data = JSON.parse(body); response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(Array.isArray(data) ? data.map(reply) : reply(data)));}
          catch {response.writeHead(400); response.end();}
        });
      }).listen(9000, '127.0.0.1', () => console.log('fixture-ready'));
    `
    mock = await docker.createContainer({Cmd: ['node', '-e', fixture], HostConfig: {CapDrop: ['ALL'], Memory: 128 * 1024 ** 2, NetworkMode: 'none', ReadonlyRootfs: true, SecurityOpt: ['no-new-privileges']}, Image: 'node:22-alpine', Tty: true})
    await mock.start()
    const readyDeadline = Date.now() + 10_000
    while (!(await mock.logs({stdout: true})).toString().includes('fixture-ready')) {
      if (Date.now() >= readyDeadline || !(await mock.inspect()).State.Running) throw new Error('Local L1 fixture failed to start')
      await new Promise(resolve => {setTimeout(resolve, 100)})
    }

    container = await docker.createContainer({
      Cmd: ['node', '--chain', '/probe-genesis.json', '--datadir', '/probe-data', '--disable-discovery', '--l1.url', 'http://127.0.0.1:9000', '--blob.mock', '--consensus.authorized-signer', '0x0000000000000000000000000000000000000001', '--http', '--http.addr', '127.0.0.1', '--http.port', '8545', '--ipcdisable'],
      HostConfig: {Binds: [`${publicGenesis}:/probe-genesis.json:ro`], CapDrop: ['ALL'], Memory: 2 * 1024 ** 3, NanoCpus: 1e9, NetworkMode: `container:${mock.id}`, SecurityOpt: ['no-new-privileges'], Tmpfs: {'/probe-data': 'rw,size=1073741824,mode=1777', '/tmp': 'rw,size=67108864'}},
      Image: image,
      Tty: true,
    })
    await container.start()
    const deadline = Date.now() + timeoutMs
    let listeningSince: number | undefined
    do {
      const state = await container.inspect()
      if (!state.State.Running) throw new Error('Reth image exited before completing startup with the selected genesis')
      const logs = (await container.logs({stderr: true, stdout: true, tail: 2000})).toString()
      if (/panicked at|fatal error/i.test(logs)) throw new Error('Reth image failed during startup with the selected genesis')
      if (/http (?:rpc )?server started|rpc http server started/i.test(logs)) listeningSince ??= Date.now()
      // Some releases open HTTP before constructing chain-specific rollup services.
      if (listeningSince !== undefined && Date.now() - listeningSince >= 3000) return {imageId: state.Image, status: 'started'}
      await new Promise(resolve => {setTimeout(resolve, 250)})
    } while (Date.now() < deadline)

    throw new Error('Reth startup was not confirmed before the deadline')
  } finally {
    try {await container?.remove({force: true, v: true})} finally {
      try {await mock?.remove({force: true, v: true})} finally {fs.rmSync(temporary, {force: true, recursive: true})}
    }
  }
}
