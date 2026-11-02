/**
 * Restore process.env in place. Replacing the object (`process.env = copy`) detaches it from the real
 * environment on Node 26: child processes spawned without `env` then ignore later changes such as PATH.
 */
export function restoreProcessEnv(snapshot: NodeJS.ProcessEnv): void {
  for (const key of Object.keys(process.env)) if (!(key in snapshot)) delete process.env[key]
  Object.assign(process.env, snapshot)
}
