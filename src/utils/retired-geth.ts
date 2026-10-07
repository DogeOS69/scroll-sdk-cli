import * as fs from 'node:fs'
import * as path from 'node:path'

/** Move retired deployable values out of the active directory without discarding key material. */
export function archiveRetiredGethValues(valuesDir: string): string[] {
  if (!fs.existsSync(valuesDir)) return []
  const files = fs.readdirSync(valuesDir).filter(file => /^l2-(?:sequencer|bootnode|rpc)-production(?:-\d+)?\.ya?ml$/.test(file))
  if (files.length === 0) return []
  const archiveRoot = path.join(valuesDir, '.retired-geth')
  fs.mkdirSync(archiveRoot, {mode: 0o700, recursive: true})
  const archive = fs.mkdtempSync(path.join(archiveRoot, 'values-'))
  return files.map(file => {
    const destination = path.join(archive, `${file}.bak`)
    fs.renameSync(path.join(valuesDir, file), destination)
    return destination
  })
}
