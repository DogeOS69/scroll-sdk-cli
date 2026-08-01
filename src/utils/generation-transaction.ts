import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const CLONE_EXCLUDES = new Set(['.git', 'dist', 'node_modules'])
const CONTENT_COMPARE_LIMIT_BYTES = 16 * 1024 * 1024
const FILE_COMPARE_BUFFER_BYTES = 1024 * 1024
const CLONED_MTIME_TOLERANCE_MS = 1

interface TreeEntry {
  kind: 'directory' | 'file' | 'symlink'
  mode: number
  mtimeMs: number
  size: number
}

interface GenerationChange {
  entryKind: TreeEntry['kind']
  kind: 'delete' | 'write'
  relativePath: string
}

function normalizeExcludedPath(root: string, value: string): string {
  const withoutTrailingSlash = value.replace(/[/\\]+$/, '')
  const normalized = path.normalize(withoutTrailingSlash)
  if (
    normalized === ''
    || normalized === '.'
    || path.isAbsolute(normalized)
    || normalized === '..'
    || normalized.startsWith(`..${path.sep}`)
  ) {
    throw new Error(`${path.join(root, '.scrollsdkignore')}: invalid deployment-relative path: ${value}`)
  }

  return normalized
}

function readCloneExcludes(root: string): Set<string> {
  const ignoreFile = path.join(root, '.scrollsdkignore')
  if (!fs.existsSync(ignoreFile)) return new Set()
  const excludes = new Set<string>()
  for (const rawLine of fs.readFileSync(ignoreFile, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line === '' || line.startsWith('#')) continue
    if (/[!*?[\]]/.test(line)) {
      throw new Error(
        `${ignoreFile}: glob/negation syntax is not supported; list a deployment-relative file or directory path: ${line}`,
      )
    }

    excludes.add(normalizeExcludedPath(root, line))
  }

  return excludes
}

function isCloneExcluded(relativePath: string, excludes: Set<string>): boolean {
  return [...excludes].some(
    excluded => relativePath === excluded || relativePath.startsWith(`${excluded}${path.sep}`),
  )
}

function pathInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

function copyFileClone(source: string, destination: string): void {
  fs.mkdirSync(path.dirname(destination), {recursive: true})
  fs.copyFileSync(source, destination, fs.constants.COPYFILE_FICLONE)
  const stat = fs.statSync(source)
  fs.chmodSync(destination, stat.mode)
  fs.utimesSync(destination, stat.atime, stat.mtime)
}

function cloneTree(
  source: string,
  destination: string,
  excludes: Set<string>,
  relative = '',
  sourceRoot = source,
): void {
  fs.mkdirSync(destination, {recursive: true})
  for (const item of fs.readdirSync(source, {withFileTypes: true})) {
    if (relative === '' && CLONE_EXCLUDES.has(item.name)) continue
    const sourcePath = path.join(source, item.name)
    const destinationPath = path.join(destination, item.name)
    const itemRelative = path.join(relative, item.name)
    if (isCloneExcluded(itemRelative, excludes)) continue
    if (item.isDirectory()) {
      cloneTree(sourcePath, destinationPath, excludes, itemRelative, sourceRoot)
    } else if (item.isFile()) {
      copyFileClone(sourcePath, destinationPath)
    } else if (item.isSymbolicLink()) {
      const target = fs.readlinkSync(sourcePath)
      const resolvedTarget = path.resolve(path.dirname(sourcePath), target)
      if (path.isAbsolute(target) || !pathInside(sourceRoot, resolvedTarget)) {
        throw new Error(
          `deployment symlink must be relative and remain inside the generation root: ${sourcePath}`,
        )
      }

      fs.symlinkSync(target, destinationPath)
    } else {
      throw new Error(`unsupported deployment filesystem entry: ${sourcePath}`)
    }
  }
}

function scanTree(root: string, excludes: Set<string>): Map<string, TreeEntry> {
  const result = new Map<string, TreeEntry>()
  const visit = (directory: string, relative: string): void => {
    for (const item of fs.readdirSync(directory, {withFileTypes: true})) {
      if (relative === '' && CLONE_EXCLUDES.has(item.name)) continue
      const itemPath = path.join(directory, item.name)
      const itemRelative = path.join(relative, item.name)
      if (isCloneExcluded(itemRelative, excludes)) continue
      const stat = fs.lstatSync(itemPath)
      const kind = item.isDirectory()
        ? 'directory'
        : item.isSymbolicLink()
          ? 'symlink'
          : item.isFile()
            ? 'file'
            : undefined
      if (!kind) throw new Error(`unsupported deployment filesystem entry: ${itemPath}`)
      result.set(itemRelative, {
        kind,
        mode: stat.mode,
        mtimeMs: stat.mtimeMs,
        size: stat.size,
      })
      if (kind === 'directory') visit(itemPath, itemRelative)
    }
  }

  visit(root, '')
  return result
}

function sameLargeFileContent(source: string, staged: string, size: number): boolean {
  const sourceFd = fs.openSync(source, 'r')
  const stagedFd = fs.openSync(staged, 'r')
  const sourceBuffer = Buffer.allocUnsafe(FILE_COMPARE_BUFFER_BYTES)
  const stagedBuffer = Buffer.allocUnsafe(FILE_COMPARE_BUFFER_BYTES)
  try {
    let position = 0
    while (position < size) {
      const length = Math.min(FILE_COMPARE_BUFFER_BYTES, size - position)
      const sourceBytes = fs.readSync(sourceFd, sourceBuffer, 0, length, position)
      const stagedBytes = fs.readSync(stagedFd, stagedBuffer, 0, length, position)
      if (
        sourceBytes !== stagedBytes
        || !sourceBuffer.subarray(0, sourceBytes).equals(stagedBuffer.subarray(0, stagedBytes))
      ) {
        return false
      }

      position += sourceBytes
    }

    return true
  } finally {
    fs.closeSync(sourceFd)
    fs.closeSync(stagedFd)
  }
}

function sameFile(source: string, staged: string, original: TreeEntry, next: TreeEntry): boolean {
  if (
    original.size > CONTENT_COMPARE_LIMIT_BYTES
    && original.size === next.size
    && original.mode === next.mode
    // fs.utimesSync accepts Date values with millisecond precision while some
    // deployment filesystems report sub-millisecond mtimes. A freshly cloned
    // multi-GB file can therefore differ by a fraction of a millisecond even
    // though no generation step touched it.
    && Math.abs(original.mtimeMs - next.mtimeMs) <= CLONED_MTIME_TOLERANCE_MS
  ) {
    return true
  }

  if (original.size !== next.size || original.mode !== next.mode) return false
  if (original.size > CONTENT_COMPARE_LIMIT_BYTES) {
    return sameLargeFileContent(source, staged, original.size)
  }

  return fs.readFileSync(source).equals(fs.readFileSync(staged))
}

function calculateChanges(
  originalRoot: string,
  stagingRoot: string,
  excludes: Set<string>,
): GenerationChange[] {
  const original = scanTree(originalRoot, excludes)
  const staged = scanTree(stagingRoot, excludes)
  const paths = new Set([...original.keys(), ...staged.keys()])
  const changes: GenerationChange[] = []
  for (const relativePath of [...paths].sort()) {
    const before = original.get(relativePath)
    const after = staged.get(relativePath)
    if (!after) {
      if (before) changes.push({entryKind: before.kind, kind: 'delete', relativePath})
      continue
    }

    if (after.kind === 'directory') continue
    if (!before || before.kind !== after.kind) {
      changes.push({entryKind: after.kind, kind: 'write', relativePath})
      continue
    }

    const originalPath = path.join(originalRoot, relativePath)
    const stagedPath = path.join(stagingRoot, relativePath)
    if (after.kind === 'symlink') {
      if (fs.readlinkSync(originalPath) !== fs.readlinkSync(stagedPath)) {
        changes.push({entryKind: after.kind, kind: 'write', relativePath})
      }
    } else if (!sameFile(originalPath, stagedPath, before, after)) {
      changes.push({entryKind: after.kind, kind: 'write', relativePath})
    }
  }

  // Delete children before their parent directory. This lets generated secret
  // bundles disappear completely instead of leaving empty mode-stale paths.
  return changes.sort((left, right) => {
    if (left.kind === 'delete' && right.kind === 'delete') {
      const depth = right.relativePath.split(path.sep).length - left.relativePath.split(path.sep).length
      if (depth !== 0) return depth
    }

    return left.relativePath.localeCompare(right.relativePath)
  })
}

function writeEntryAtomically(source: string, destination: string): void {
  fs.mkdirSync(path.dirname(destination), {recursive: true})
  const temporary = `${destination}.scrollsdk-generation-${process.pid}`
  fs.rmSync(temporary, {force: true, recursive: true})
  const stat = fs.lstatSync(source)
  if (stat.isSymbolicLink()) {
    fs.symlinkSync(fs.readlinkSync(source), temporary)
  } else {
    copyFileClone(source, temporary)
  }

  fs.renameSync(temporary, destination)
}

/**
 * Copy-on-write generation workspace with a rollback-capable file commit.
 *
 * Existing setup code runs against stagingRoot. commit() computes the complete
 * generated file delta, backs up every destination, and then installs each
 * staged file through same-directory rename. A commit failure restores all
 * touched paths before surfacing the error.
 */
export class GenerationTransaction {
  readonly originalRoot: string
  readonly stagingRoot: string

  private readonly cloneExcludes: Set<string>
  private finished = false

  private constructor(originalRoot: string, stagingRoot: string, cloneExcludes: Set<string>) {
    this.originalRoot = originalRoot
    this.stagingRoot = stagingRoot
    this.cloneExcludes = cloneExcludes
  }

  static begin(originalRoot = '.'): GenerationTransaction {
    const resolved = path.resolve(originalRoot)
    if (!fs.statSync(resolved).isDirectory()) {
      throw new Error(`generation root is not a directory: ${resolved}`)
    }

    const stagingRoot = fs.mkdtempSync(
      path.join(path.dirname(resolved), `.${path.basename(resolved)}.scrollsdk-generation-`),
    )
    try {
      const cloneExcludes = readCloneExcludes(resolved)
      cloneTree(resolved, stagingRoot, cloneExcludes)
      return new GenerationTransaction(resolved, stagingRoot, cloneExcludes)
    } catch (error) {
      fs.rmSync(stagingRoot, {force: true, recursive: true})
      throw error
    }
  }

  commit(): {changedFiles: string[]} {
    if (this.finished) throw new Error('generation transaction is already finished')
    const changes = calculateChanges(this.originalRoot, this.stagingRoot, this.cloneExcludes)
    const backupRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'scrollsdk-generation-backup-'))
    const existed = new Set<string>()
    try {
      for (const change of changes) {
        const destination = path.join(this.originalRoot, change.relativePath)
        try {
          const stat = fs.lstatSync(destination)
          existed.add(change.relativePath)
          const backup = path.join(backupRoot, change.relativePath)
          if (stat.isSymbolicLink()) {
            fs.mkdirSync(path.dirname(backup), {recursive: true})
            fs.symlinkSync(fs.readlinkSync(destination), backup)
          } else if (!stat.isDirectory()) {
            copyFileClone(destination, backup)
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        }
      }

      for (const change of changes) {
        const destination = path.join(this.originalRoot, change.relativePath)
        if (change.kind === 'delete') {
          if (change.entryKind === 'directory') fs.rmdirSync(destination)
          else fs.rmSync(destination, {force: true})
        } else {
          writeEntryAtomically(
            path.join(this.stagingRoot, change.relativePath),
            destination,
          )
        }
      }

      this.finished = true
      return {
        changedFiles: changes.map(change => path.join(this.originalRoot, change.relativePath)),
      }
    } catch (error) {
      for (const change of [...changes].reverse()) {
        const destination = path.join(this.originalRoot, change.relativePath)
        if (!existed.has(change.relativePath)) {
          fs.rmSync(destination, {force: true, recursive: true})
          continue
        }

        if (change.entryKind === 'directory') fs.mkdirSync(destination, {recursive: true})
        else writeEntryAtomically(path.join(backupRoot, change.relativePath), destination)
      }

      throw error
    } finally {
      fs.rmSync(backupRoot, {force: true, recursive: true})
      fs.rmSync(this.stagingRoot, {force: true, recursive: true})
    }
  }

  rollback(): void {
    if (this.finished) return
    this.finished = true
    fs.rmSync(this.stagingRoot, {force: true, recursive: true})
  }

  toOriginalPath(stagedPath: string): string {
    const resolved = path.resolve(stagedPath)
    if (!pathInside(this.stagingRoot, resolved)) return resolved
    return path.join(this.originalRoot, path.relative(this.stagingRoot, resolved))
  }

  toStagingPath(originalPath: string): string {
    const resolved = path.resolve(originalPath)
    if (!pathInside(this.originalRoot, resolved)) {
      throw new Error(`transaction path is outside deployment root: ${resolved}`)
    }

    return path.join(this.stagingRoot, path.relative(this.originalRoot, resolved))
  }
}
