/** Conservative CLI-safe subset of CubeSigner role names, checked before key creation. */
export function validateCubesignerRolePrefix(prefix: string): void {
    if (!prefix || /\W/.test(prefix)) {
        throw new Error('CubeSigner role prefix must contain only ASCII letters, digits and underscores; use tee_devnet instead of tee-devnet.')
    }
}
