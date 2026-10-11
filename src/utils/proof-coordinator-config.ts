import * as toml from '@iarna/toml'

/** beta.6 batches consume per-claim chunk witnesses, not an RPC or shared witness directory. */
export function removeRetiredBatchWitnessSources(source: string): string {
  const config = toml.parse(source)
  const materializer = config.materializer as toml.JsonMap | undefined
  const batch = materializer?.scroll_batch as toml.JsonMap | undefined
  const subprocess = batch?.subprocess as toml.JsonMap | undefined
  if (!subprocess || !('l2_rpc_url' in subprocess || 'block_witness_dir' in subprocess)) return source
  delete subprocess.l2_rpc_url
  delete subprocess.block_witness_dir
  return toml.stringify(config)
}
