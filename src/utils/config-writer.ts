import * as toml from '@iarna/toml'
import chalk from 'chalk'
import * as fs from 'node:fs'
import * as path from 'node:path'

type TomlPrimitive = Date | bigint | boolean | null | number | string
type TomlValue = TomlObject | TomlPrimitive | TomlValue[]
interface TomlObject { [key: string]: TomlValue }

function convertBigIntsToStringsRecursive(obj: TomlValue): TomlValue {
    if (obj === null || typeof obj !== 'object') {
        if (typeof obj === 'bigint') {
            return obj.toString()
        }

        return obj;
    }

    if (Array.isArray(obj)) {
        return obj.map(item => convertBigIntsToStringsRecursive(item));
    }

    const newObj: TomlObject = {};
    for (const key in obj) {
        if (Object.hasOwn(obj, key)) {
            const value = (obj as TomlObject)[key];
            newObj[key] = typeof value === 'bigint' ? value.toString() :
                typeof value === 'object' ? convertBigIntsToStringsRecursive(value) :
                    value;
        }
    }

    return newObj;
}

/**
 * Deep clones a TOML-parsed object.
 * @iarna/toml.parse returns a JsonMap which is compatible with JSON stringify/parse.
 * @param obj The object to clone.
 * @returns A deep clone of the object.
 */
function deepClone<T>(obj: T): T {
    return JSON.parse(JSON.stringify(obj));
}

/**
 * Writes an updated main configuration (object or string) and its sanitized public version to their respective files atomically.
 * Writes the updated main config object to a temporary file first, then generates and syncs the public config,
 * and finally renames the temporary file to the main config path if both succeed.
 *
 * @param updatedMainConfig The updated main config data to be written. Can be a parsed TOML object or a TOML string.
 * @param publicConfigPath Path where the config.public.toml file will be written.
 * @param mainConfigPath Path to the main config.toml file. Defaults to ./config.toml.
 * @param silent If true, suppresses console output (for JSON mode). Defaults to false.
 * @returns `true` if both files were written successfully, `false` on error.
 * Returns `void` if the `mainConfigPath` does not exist and the function exits early.
 */
export function writeConfigs(
    updatedMainConfigOrString: TomlObject | string,
    publicConfigPath: string = path.join(process.cwd(), 'config.public.toml'),
    mainConfigPath: string = path.join(process.cwd(), 'config.toml'),
    silent: boolean = false,
): boolean | void {
    try {
        if (!fs.existsSync(mainConfigPath)) {
            console.warn(chalk.yellow(`Main config file ${mainConfigPath} not found. Skipping public config sync.`))
            return;
        }

        let mainConfigObjectForProcessing: TomlObject;
        let mainConfigStringToWrite: string;

        if (typeof updatedMainConfigOrString === 'string') {
            mainConfigStringToWrite = updatedMainConfigOrString;
            // Parse the string, then convert BigInts for public config generation
            const parsedObject = toml.parse(mainConfigStringToWrite);
            mainConfigObjectForProcessing = convertBigIntsToStringsRecursive(parsedObject) as TomlObject;
        } else {
            // updatedMainConfigOrString is an object. Convert BigInts first.
            mainConfigObjectForProcessing = convertBigIntsToStringsRecursive(updatedMainConfigOrString) as TomlObject;
            // Then stringify the processed object for writing.
            mainConfigStringToWrite = toml.stringify(mainConfigObjectForProcessing as toml.JsonMap);
        }

        const publicConfig = deepClone(mainConfigObjectForProcessing);

        // 1. Remove entire [db] section as all connection strings are sensitive
        //    Alternatively, iterate and delete keys if the [db] section itself must exist but be empty.
        if (publicConfig.db) {
            delete publicConfig.db
        }
        
        // 2. Remove private keys from [accounts]
        if (publicConfig.accounts && typeof publicConfig.accounts === 'object') {
            const accounts = publicConfig.accounts as TomlObject
            for (const key of Object.keys(accounts)) {
                if (key.endsWith('_PRIVATE_KEY')) {
                    delete accounts[key]
                }

                // Also remove OWNER_PRIVATE_KEY (if it exists)
                if (key === 'OWNER_PRIVATE_KEY') {
                    delete accounts[key];
                }
            }
        }

        // 3. Remove sensitive info from [sequencer] and [sequencer.sequencer-X]
        if (publicConfig.sequencer && typeof publicConfig.sequencer === 'object') {
            const sequencer = publicConfig.sequencer as TomlObject
            // Main sequencer section
            delete sequencer.L2GETH_PASSWORD
            delete sequencer.L2GETH_KEYSTORE

            // Sequencer sub-sections (sequencer-1, sequencer-2, etc.)
            for (const key in sequencer) {
                if (key.startsWith('sequencer-') && typeof sequencer[key] === 'object') {
                    const subSequencer = sequencer[key] as TomlObject
                    delete subSequencer.L2GETH_PASSWORD
                    delete subSequencer.L2GETH_KEYSTORE
                }
            }
        }

        // 4. Remove JWT secret from [coordinator]
        if (publicConfig.coordinator && typeof publicConfig.coordinator === 'object') {
            const coordinator = publicConfig.coordinator as TomlObject
            delete coordinator.COORDINATOR_JWT_SECRET_KEY
        }

        // 5. Remove API keys from [contracts.verification]
        if (publicConfig.contracts && typeof publicConfig.contracts === 'object') {
            const contracts = publicConfig.contracts as TomlObject
            if (contracts.verification && typeof contracts.verification === 'object') {
                const verification = contracts.verification as TomlObject
                delete verification.EXPLORER_API_KEY_L1
                delete verification.EXPLORER_API_KEY_L2
            }
        }

        // 6. Remove node private keys (L2GETH_NODEKEY) from all sections
        const removeNodeKeys = (obj: TomlObject) => {
            delete obj.L2GETH_NODEKEY
            for (const key in obj) {
                if (obj[key] && typeof obj[key] === 'object' && !Array.isArray(obj[key])) {
                    removeNodeKeys(obj[key] as TomlObject)
                }
            }
        }

        removeNodeKeys(publicConfig)

        fs.writeFileSync(mainConfigPath, mainConfigStringToWrite);
        if (!silent) {
            console.log(chalk.green(`Main config updated: ${mainConfigPath}`));
        }

        // 2. Write the public config
        fs.writeFileSync(publicConfigPath, toml.stringify(publicConfig as toml.JsonMap))
        if (!silent) {
            console.log(chalk.green(`Public configuration synced to ${publicConfigPath}`));
        }

        return true
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error)
        // Always log errors to stderr
        console.error(chalk.red(`Error syncing public config: ${errorMessage}`))
        return false // Operation failed
    }
}