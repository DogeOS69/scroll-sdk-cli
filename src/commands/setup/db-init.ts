import { Command, Flags } from '@oclif/core'
import { input, password, confirm } from '@inquirer/prompts'
import pg from 'pg';
import * as fs from 'fs'
import * as path from 'path'
import * as toml from '@iarna/toml'
import chalk from 'chalk'
import { writeConfigs } from '../../utils/config-writer.js'
import {
  createNonInteractiveContext,
  resolveOrPrompt,
  resolveConfirm,
  resolveEnvValue,
  validateAndExit,
  type NonInteractiveContext,
} from '../../utils/non-interactive.js'
import { JsonOutputContext, ERROR_CODES, getErrorMeta } from '../../utils/json-output.js'

export default class SetupDbInit extends Command {
  static override description = 'Initialize databases with new users and passwords interactively or update permissions'

  static override examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> --update-permissions',
    '<%= config.bin %> <%= command.id %> --update-permissions --debug',
    '<%= config.bin %> <%= command.id %> --clean',
    '<%= config.bin %> <%= command.id %> --update-db-port=25061',
    '<%= config.bin %> <%= command.id %> --non-interactive',
    '<%= config.bin %> <%= command.id %> --non-interactive --json --clean',
  ]

  static override flags = {
    'update-permissions': Flags.boolean({
      char: 'u',
      description: 'Update permissions for existing users',
      default: false,
    }),
    debug: Flags.boolean({
      char: 'd',
      description: 'Show debug output including SQL queries',
      default: false,
    }),
    clean: Flags.boolean({
      char: 'c',
      description: 'Delete existing database and user before creating new ones',
      default: false,
    }),
    'update-port': Flags.integer({
      description: 'Update the port of current database values',
      required: false,
    }),
    'non-interactive': Flags.boolean({
      char: 'N',
      description: 'Run without prompts, using config.toml values. Requires [db.admin] section with PUBLIC_HOST, PUBLIC_PORT, USERNAME, PASSWORD (or $ENV: refs)',
      default: false,
    }),
    json: Flags.boolean({
      description: 'Output in JSON format (stdout for data, stderr for logs)',
      default: false,
    }),
  }

  private conn: pg.Client | undefined;
  private publicHost: string = "";
  private publicPort: string = "";
  private vpcHost: string = "";
  private vpcPort: string = "";
  private pgUser: string = "";
  private pgPassword: string = "";
  private pgDatabase: string = "";

  private async initializeDatabase(conn: pg.Client, dbName: string, dbUser: string, dbPassword: string, clean: boolean, niCtx?: NonInteractiveContext): Promise<void> {
    try {
      // Check if the database exists
      const dbExistsResult = await conn.query(`SELECT 1 FROM pg_database WHERE datname = $1`, [dbName])
      if (dbExistsResult.rows.length > 0) {
        if (clean) {
          this.log(chalk.yellow(`Deleting existing database ${dbName}...`))
          // Terminate all connections to the database
          await conn.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1`, [dbName])
          await conn.query(`DROP DATABASE IF EXISTS ${dbName}`)
          this.log(chalk.green(`Database ${dbName} deleted successfully.`))
        } else {
          this.log(chalk.yellow(`Database ${dbName} already exists.`))
        }
      }

      if (clean || dbExistsResult.rows.length === 0) {
        this.log(chalk.blue(`Creating database ${dbName}...`))
        await conn.query(`CREATE DATABASE ${dbName}`)
        this.log(chalk.green(`Database ${dbName} created successfully.`))
      }

      // Check if the user exists
      const userExistsResult = await conn.query(`SELECT 1 FROM pg_roles WHERE rolname = $1`, [dbUser])
      if (userExistsResult.rows.length > 0) {
        if (clean) {
          this.log(chalk.yellow(`User ${dbUser} already exists. Updating password...`))
          await conn.query(`ALTER USER ${dbUser} WITH PASSWORD '${dbPassword.replace(/'/g, "''")}'`)
          this.log(chalk.green(`Password updated for ${dbUser}.`))
        } else {
          // In non-interactive mode, update password if one was provided
          const changePassword = await resolveConfirm(
            niCtx!,
            () => confirm({ message: `User ${dbUser} already exists. Do you want to change the password?` }),
            true, // In non-interactive, update password if provided
            true
          )
          if (changePassword) {
            await conn.query(`ALTER USER ${dbUser} WITH PASSWORD '${dbPassword.replace(/'/g, "''")}'`)
            this.log(chalk.green(`Password updated for ${dbUser}.`))
          } else {
            this.log(chalk.yellow(`Password not changed for ${dbUser}. Please manually check the user's password in config.toml.`))
          }
        }
      } else {
        this.log(chalk.blue(`Creating user ${dbUser}...`))
        await conn.query(`CREATE USER ${dbUser} WITH PASSWORD '${dbPassword.replace(/'/g, "''")}'`)
        this.log(chalk.green(`User ${dbUser} created successfully.`))
      }

      // Update permissions
      await this.updatePermissions(conn, dbName, dbUser, false) // Pass false for debug flag

    } catch (error) {
      this.error(chalk.red(`Failed to initialize database: ${error}`))
    }
  }

  private async updateConfigFile(dsnMap: Record<string, string>, jsonMode: boolean = false): Promise<void> {
    const configPath = path.join(process.cwd(), 'config.toml')
    if (!fs.existsSync(configPath)) {
      // Log to stderr in JSON mode
      console.error(chalk.yellow('config.toml not found in the current directory. Skipping update.'))
      return
    }

    const configContent = fs.readFileSync(configPath, 'utf-8')
    const config = toml.parse(configContent)

    if (!config.db) {
      config.db = {}
    }

    const dsnConfigMapping: Record<string, string[]> = {
      'ROLLUP_NODE': ['SCROLL_DB_CONNECTION_STRING', 'GAS_ORACLE_DB_CONNECTION_STRING', 'ROLLUP_NODE_DB_CONNECTION_STRING', 'ROLLUP_EXPLORER_DB_CONNECTION_STRING', 'COORDINATOR_DB_CONNECTION_STRING', 'ADMIN_SYSTEM_BACKEND_DB_CONNECTION_STRING'],
      'BRIDGE_HISTORY': ['BRIDGE_HISTORY_DB_CONNECTION_STRING'],
      'CHAIN_MONITOR': ['CHAIN_MONITOR_DB_CONNECTION_STRING'],
      'BLOCKSCOUT': ['BLOCKSCOUT_DB_CONNECTION_STRING'],
      'L1_EXPLORER': ['L1_EXPLORER_DB_CONNECTION_STRING']
    }

    for (const [user, dsn] of Object.entries(dsnMap)) {
      const configKeys = dsnConfigMapping[user] || []
      for (const key of configKeys) {
        (config.db as Record<string, string>)[key] = dsn
      }
    }

    // Pass silent=true when in JSON mode to avoid stdout pollution
    if (writeConfigs(config, undefined, undefined, jsonMode)) {
      if (!jsonMode) {
        this.log(chalk.green('config.toml has been updated with the new database connection strings.'))
      }
    }
  }

  private async updatePermissions(conn: pg.Client, dbName: string, dbUser: string, debug: boolean): Promise<void> {
    const queries = [
      `GRANT CONNECT ON DATABASE ${dbName} TO ${dbUser}`,
      `GRANT ALL PRIVILEGES ON DATABASE ${dbName} TO ${dbUser}`,
    ];

    const schemaQueries = [
      `CREATE SCHEMA IF NOT EXISTS public`,
      `GRANT ALL PRIVILEGES ON SCHEMA public TO ${dbUser}`,
      `GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO ${dbUser}`,
      `GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO ${dbUser}`,
      `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO ${dbUser}`,
      `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO ${dbUser}`
    ];

    try {
      // Execute queries on the original connection (usually connected to 'postgres' database)
      for (const query of queries) {
        if (debug) {
          this.log(chalk.cyan(`Executing query: ${query}`));
        }
        const result = await conn.query(query);
        if (debug) {
          this.log(chalk.yellow('Query result:'));
          this.log(JSON.stringify(result, null, 2));
        }
      }

      // Create a new connection to the specific database
      const dbConn = await this.createConnection(this.publicHost, this.publicPort, this.pgUser, this.pgPassword, dbName);

      // Execute schema-specific queries on the new connection
      for (const query of schemaQueries) {
        if (debug) {
          this.log(chalk.cyan(`Executing query on ${dbName}: ${query}`));
        }
        const result = await dbConn.query(query);
        if (debug) {
          this.log(chalk.yellow('Query result:'));
          this.log(JSON.stringify(result, null, 2));
        }
      }

      // Close the database-specific connection
      await dbConn.end();

      this.log(chalk.green(`Permissions updated for ${dbUser} on ${dbName}.`))
    } catch (error) {
      this.error(chalk.red(`Failed to update permissions: ${error}`))
    }
  }

  private updateDatabasePort(config: any, newPort: number): void {
    const dbSection = config.db as Record<string, string>
    if (!dbSection) {
      this.log(chalk.yellow('No database configurations found in config.toml'))
      return
    }

    let changes = false
    for (const [key, value] of Object.entries(dbSection)) {
      if (typeof value === 'string' && value.includes('postgres://')) {
        const updatedValue = value.replace(/:\d+\//, `:${newPort}/`)
        if (updatedValue !== value) {
          dbSection[key] = updatedValue
          changes = true
          this.log(chalk.blue(`Updated ${key}:`))
          this.log(chalk.red(`- ${value}`))
          this.log(chalk.green(`+ ${updatedValue}`))
        }
      }
    }

    if (!changes) {
      this.log(chalk.yellow('No database configurations were updated'))
    }
  }

  private async getExistingConfig(): Promise<any> {
    const configPath = path.join(process.cwd(), 'config.toml')
    if (!fs.existsSync(configPath)) {
      this.error('config.toml not found in the current directory.')
      return {}
    }

    const configContent = fs.readFileSync(configPath, 'utf-8')
    return toml.parse(configContent) as any
  }

  public async run(): Promise<void> {
    const { flags } = await this.parse(SetupDbInit)
    const existingConfig = await this.getExistingConfig()

    // Create non-interactive and JSON output contexts
    const niCtx = createNonInteractiveContext(
      'setup db-init',
      flags['non-interactive'],
      flags.json
    )
    const jsonCtx = new JsonOutputContext('setup db-init', flags.json)

    // Helper for logging
    const log = (msg: string) => jsonCtx.log(msg)

    if (flags['update-port']) {
      log(chalk.blue('Updating database port...'))
      this.updateDatabasePort(existingConfig, flags['update-port'])

      const confirmUpdate = await resolveConfirm(
        niCtx,
        () => confirm({
          message: 'Do you want to update the config.toml file with these changes?'
        }),
        true, // In non-interactive mode, always update
        true
      )

      if (confirmUpdate) {
        if (writeConfigs(existingConfig)) {
          log(chalk.green('config.toml has been updated with the new database port.'))
          if (flags.json) {
            jsonCtx.success({ updated: true, action: 'update-port', port: flags['update-port'] })
          }
        }
      } else {
        log(chalk.yellow('Configuration update cancelled.'))
      }
      return
    }

    if (flags.clean) {
      // In non-interactive mode with --clean, proceed without confirmation
      const confirmClean = await resolveConfirm(
        niCtx,
        () => confirm({
          message: chalk.red('WARNING: This will erase existing databases and overwrite user passwords. Do you want to continue?'),
        }),
        true, // In non-interactive mode with --clean flag, proceed
        true
      )
      if (!confirmClean) {
        log(chalk.yellow('Operation aborted.'))
        return
      }
    }

    const databases = [
      { name: 'scroll_chain_monitor', user: 'CHAIN_MONITOR' },
      { name: 'scroll_rollup', user: 'ROLLUP_NODE' },
      { name: 'scroll_bridge_history', user: 'BRIDGE_HISTORY' },
    ]

    // In non-interactive mode, check if Blockscout DB string exists in config
    const createBlockscout = await resolveConfirm(
      niCtx,
      () => confirm({
        message: chalk.cyan('Do you want to create a database for Blockscout?'),
        default: !!existingConfig.db?.BLOCKSCOUT_DB_CONNECTION_STRING
      }),
      existingConfig.db?.CREATE_BLOCKSCOUT_DB ?? !!existingConfig.db?.BLOCKSCOUT_DB_CONNECTION_STRING,
      !!existingConfig.db?.BLOCKSCOUT_DB_CONNECTION_STRING
    )
    if (createBlockscout) {
      databases.push({ name: 'scroll_blockscout', user: 'BLOCKSCOUT' })
    }

    // In non-interactive mode, check if L1 Explorer DB string exists in config
    const createL1Explorer = await resolveConfirm(
      niCtx,
      () => confirm({
        message: chalk.cyan('Do you want to create a database for L1 Explorer?'),
        default: !!existingConfig.db?.L1_EXPLORER_DB_CONNECTION_STRING
      }),
      existingConfig.db?.CREATE_L1_EXPLORER_DB ?? !!existingConfig.db?.L1_EXPLORER_DB_CONNECTION_STRING,
      !!existingConfig.db?.L1_EXPLORER_DB_CONNECTION_STRING
    )
    if (createL1Explorer) {
      databases.push({ name: 'scroll_l1explorer', user: 'L1_EXPLORER' })
    }

    const dsnMap: Record<string, string> = {}
    const createdDatabases: string[] = []

    try {
      // If updating permissions, we only need to connect once
      if (flags['update-permissions']) {
        [this.publicHost, this.publicPort, this.pgUser, this.pgPassword, this.pgDatabase] = await this.promptForPublicConnectionDetails(existingConfig, niCtx);

        // Validate required fields were resolved
        validateAndExit(niCtx)

        this.conn = await this.createConnection(this.publicHost, this.publicPort, this.pgUser, this.pgPassword, this.pgDatabase);
      }

      for (const db of databases) {
        log(chalk.blue(`Setting up db for ${db.name}`));

        if (!flags['update-permissions']) {
          // First iteration or if the user chose to connect to a different cluster
          if (!this.conn) {
            [this.publicHost, this.publicPort, this.vpcHost, this.vpcPort, this.pgUser, this.pgPassword, this.pgDatabase] = await this.promptForConnectionDetails(existingConfig, niCtx);

            // Validate required fields were resolved
            validateAndExit(niCtx)

            this.conn = await this.createConnection(this.publicHost, this.publicPort, this.pgUser, this.pgPassword, this.pgDatabase);
          } else {
            // In non-interactive mode, never prompt to switch clusters
            const switchCluster = await resolveConfirm(
              niCtx,
              () => confirm({ message: 'Do you want to connect to a different database cluster for this database?', default: false }),
              false, // In non-interactive, don't switch clusters
              false
            )
            if (switchCluster) {
              // User chose to connect to a different cluster
              await this.conn.end();
              [this.publicHost, this.publicPort, this.vpcHost, this.vpcPort, this.pgUser, this.pgPassword, this.pgDatabase] = await this.promptForConnectionDetails(existingConfig, niCtx);
              validateAndExit(niCtx)
              this.conn = await this.createConnection(this.publicHost, this.publicPort, this.pgUser, this.pgPassword, this.pgDatabase);
            }
          }
        }

        if (!this.conn) {
          if (flags.json) {
            jsonCtx.error(
              'E304_DATABASE_UNREACHABLE',
              'Database connection not established',
              'NETWORK',
              true,
              { host: this.publicHost, port: this.publicPort }
            )
          }
          throw new Error('Database connection not established');
        }

        if (flags['update-permissions']) {
          if (flags.debug) {
            log(chalk.yellow('Debug mode: Showing SQL queries'));
          }
          await this.updatePermissions(this.conn, db.name, db.user.toLowerCase(), flags.debug)
        } else {
          log(chalk.blue(`Setting up database: ${db.name} for user: ${db.user}`))

          let dbPassword: string;
          const existingDsn = existingConfig.db?.[`${db.user}_DB_CONNECTION_STRING`];

          // Check for password in config (supports $ENV: pattern)
          const configPassword = resolveEnvValue(existingConfig.db?.[`${db.user}_PASSWORD`])

          if (niCtx.enabled) {
            // Non-interactive mode: use config password, existing DSN password, or generate random
            if (configPassword) {
              dbPassword = configPassword
              log(chalk.green(`Using configured password for ${db.user}`))
            } else if (existingDsn) {
              dbPassword = existingDsn.match(/postgres:\/\/.*:(.*)@/)?.[1] || '';
              if (dbPassword) {
                log(chalk.green(`Using existing password from DSN for ${db.user}`))
              } else {
                dbPassword = Math.random().toString(36).slice(-12);
                log(chalk.green(`Generated random password for ${db.user}`))
              }
            } else {
              dbPassword = Math.random().toString(36).slice(-12);
              log(chalk.green(`Generated random password for ${db.user}`))
            }
          } else {
            // Interactive mode - original logic
            if (existingDsn) {
              const keepExistingPassword = await confirm({
                message: `An existing password was found for ${db.user}. Do you want to keep it?`,
                default: true
              });
              if (keepExistingPassword) {
                dbPassword = existingDsn.match(/postgres:\/\/.*:(.*)@/)?.[1] || '';
                log(chalk.green(`Using existing password for ${db.user}`));
              } else {
                const useRandomPassword = await confirm({
                  message: `Do you want to use a random password for ${db.user}?`,
                  default: true
                });
                if (useRandomPassword) {
                  dbPassword = Math.random().toString(36).slice(-12);
                  log(chalk.green(`Generated random password for ${db.user}`));
                } else {
                  dbPassword = await password({ message: `Enter new password for ${db.user}:` });
                }
              }
            } else {
              const useRandomPassword = await confirm({
                message: `Do you want to use a random password for ${db.user}?`,
                default: true
              });
              if (useRandomPassword) {
                dbPassword = Math.random().toString(36).slice(-12);
                log(chalk.green(`Generated random password for ${db.user}`));
              } else {
                dbPassword = await password({ message: `Enter password for ${db.user}:` });
              }
            }
          }

          await this.initializeDatabase(this.conn, db.name, db.user.toLowerCase(), dbPassword, flags.clean, niCtx)

          const dsn = `postgres://${db.user.toLowerCase()}:${dbPassword}@${this.vpcHost}:${this.vpcPort}/${db.name}?sslmode=require`
          log(chalk.cyan(`DSN for ${db.user}:\n${dsn}`))

          dsnMap[db.user] = dsn
          createdDatabases.push(db.name)
        }
      }

      if (!flags['update-permissions']) {
        log(chalk.green('All databases initialized successfully.'))

        const updateConfig = await resolveConfirm(
          niCtx,
          () => confirm({ message: 'Do you want to update the config.toml file with the new DSNs?' }),
          true, // In non-interactive, always update config
          true
        )
        if (updateConfig) {
          await this.updateConfigFile(dsnMap, flags.json)
        }

        // Output JSON response on success
        if (flags.json) {
          jsonCtx.success({
            action: 'db-init',
            databases: createdDatabases,
            configUpdated: updateConfig,
          })
        }
      } else {
        log(chalk.green('Permissions updated for all databases.'))
        if (flags.json) {
          jsonCtx.success({
            action: 'update-permissions',
            databases: databases.map(d => d.name),
          })
        }
      }
    } catch (error) {
      if (flags.json) {
        const errorMsg = error instanceof Error ? error.message : String(error)
        jsonCtx.error(
          'E304_DATABASE_UNREACHABLE',
          `Database operation failed: ${errorMsg}`,
          'NETWORK',
          true,
          { error: errorMsg }
        )
      }
      throw error
    } finally {
      if (this.conn) {
        await this.conn.end()
      }
    }
  }

  private async promptForConnectionDetails(existingConfig: any, niCtx?: NonInteractiveContext): Promise<[string, string, string, string, string, string, string]> {
    this.log(chalk.blue('First, provide connection information for the database instance. This will only be used for creating users and databases. This information will not be persisted in your configuration repo.'));

    // For non-interactive mode, look for [db.admin] section in config
    const adminConfig = existingConfig.db?.admin || {}

    const publicHost = await resolveOrPrompt(
      niCtx!,
      () => input({ message: 'Enter public PostgreSQL host:', default: 'localhost' }),
      resolveEnvValue(adminConfig.PUBLIC_HOST) || 'localhost',
      {
        field: 'PUBLIC_HOST',
        configPath: '[db.admin].PUBLIC_HOST',
        description: 'Public PostgreSQL host for admin connections',
      }
    ) || 'localhost'

    const publicPort = await resolveOrPrompt(
      niCtx!,
      () => input({ message: 'Enter public PostgreSQL port:', default: '5432' }),
      resolveEnvValue(adminConfig.PUBLIC_PORT) || '5432',
      {
        field: 'PUBLIC_PORT',
        configPath: '[db.admin].PUBLIC_PORT',
        description: 'Public PostgreSQL port for admin connections',
      }
    ) || '5432'

    const pgUser = await resolveOrPrompt(
      niCtx!,
      () => input({ message: 'Enter PostgreSQL admin username:', default: 'dogeosadmin' }),
      resolveEnvValue(adminConfig.USERNAME) || 'dogeosadmin',
      {
        field: 'USERNAME',
        configPath: '[db.admin].USERNAME',
        description: 'PostgreSQL admin username',
      }
    ) || 'dogeosadmin'

    // Password is required - in non-interactive mode, must come from config or $ENV:
    let pgPassword: string
    if (niCtx?.enabled) {
      const configPassword = resolveEnvValue(adminConfig.PASSWORD)
      if (!configPassword) {
        niCtx.missingFields.push({
          field: 'PASSWORD',
          configPath: '[db.admin].PASSWORD',
          description: 'PostgreSQL admin password (use $ENV:VAR_NAME for secrets)',
        })
        pgPassword = ''
      } else {
        pgPassword = configPassword
      }
    } else {
      pgPassword = await password({ message: 'Enter PostgreSQL admin password:' })
    }

    const pgDatabase = await resolveOrPrompt(
      niCtx!,
      () => input({ message: 'Enter PostgreSQL database name:', default: 'postgres' }),
      resolveEnvValue(adminConfig.DATABASE) || 'postgres',
      {
        field: 'DATABASE',
        configPath: '[db.admin].DATABASE',
        description: 'PostgreSQL database name for admin connection',
      },
      false
    ) || 'postgres'

    this.log(chalk.blue('Now, provide connection information for pods. This will often be use localhost or a private IP. This information is stored in DSN strings in your configuration file and used in Secrets.'));

    // Extract host and port from an existing DSN if available
    let defaultPrivateHost = 'localhost'
    let defaultPrivatePort = '5432'
    const existingDsn = existingConfig.db?.SCROLL_DB_CONNECTION_STRING
    if (existingDsn) {
      const dsnMatch = existingDsn.match(/postgres:\/\/.*:.*@(.+):(\d+)\/.*/)
      if (dsnMatch) {
        defaultPrivateHost = dsnMatch[1]
        defaultPrivatePort = dsnMatch[2]
      }
    }

    const privateHost = await resolveOrPrompt(
      niCtx!,
      () => input({ message: 'Enter PostgreSQL host:', default: defaultPrivateHost }),
      resolveEnvValue(adminConfig.VPC_HOST) || defaultPrivateHost,
      {
        field: 'VPC_HOST',
        configPath: '[db.admin].VPC_HOST',
        description: 'PostgreSQL VPC/private host for pod connections',
      }
    ) || defaultPrivateHost

    const privatePort = await resolveOrPrompt(
      niCtx!,
      () => input({ message: 'Enter PostgreSQL port:', default: defaultPrivatePort }),
      resolveEnvValue(adminConfig.VPC_PORT) || defaultPrivatePort,
      {
        field: 'VPC_PORT',
        configPath: '[db.admin].VPC_PORT',
        description: 'PostgreSQL VPC/private port for pod connections',
      }
    ) || defaultPrivatePort

    return [publicHost, publicPort, privateHost, privatePort, pgUser, pgPassword, pgDatabase]
  }

  private async promptForPublicConnectionDetails(existingConfig: any, niCtx?: NonInteractiveContext): Promise<[string, string, string, string, string]> {
    this.log(chalk.blue('Provide connection information for the database instance. This will only be used for updating permissions.'));

    // For non-interactive mode, look for [db.admin] section in config
    const adminConfig = existingConfig.db?.admin || {}

    // Extract host and port from an existing DSN if available
    let defaultHost = 'localhost'
    let defaultPort = '5432'
    const existingDsn = existingConfig.db?.SCROLL_DB_CONNECTION_STRING
    if (existingDsn) {
      const dsnMatch = existingDsn.match(/postgres:\/\/.*:.*@(.+):(\d+)\/.*/)
      if (dsnMatch) {
        defaultHost = dsnMatch[1]
        defaultPort = dsnMatch[2]
      }
    }

    const publicHost = await resolveOrPrompt(
      niCtx!,
      () => input({ message: 'Enter public PostgreSQL host:', default: defaultHost }),
      resolveEnvValue(adminConfig.PUBLIC_HOST) || defaultHost,
      {
        field: 'PUBLIC_HOST',
        configPath: '[db.admin].PUBLIC_HOST',
        description: 'Public PostgreSQL host for admin connections',
      }
    ) || defaultHost

    const publicPort = await resolveOrPrompt(
      niCtx!,
      () => input({ message: 'Enter public PostgreSQL port:', default: defaultPort }),
      resolveEnvValue(adminConfig.PUBLIC_PORT) || defaultPort,
      {
        field: 'PUBLIC_PORT',
        configPath: '[db.admin].PUBLIC_PORT',
        description: 'Public PostgreSQL port for admin connections',
      }
    ) || defaultPort

    const pgUser = await resolveOrPrompt(
      niCtx!,
      () => input({ message: 'Enter PostgreSQL admin username:', default: 'admin' }),
      resolveEnvValue(adminConfig.USERNAME) || 'admin',
      {
        field: 'USERNAME',
        configPath: '[db.admin].USERNAME',
        description: 'PostgreSQL admin username',
      }
    ) || 'admin'

    // Password is required - in non-interactive mode, must come from config or $ENV:
    let pgPassword: string
    if (niCtx?.enabled) {
      const configPassword = resolveEnvValue(adminConfig.PASSWORD)
      if (!configPassword) {
        niCtx.missingFields.push({
          field: 'PASSWORD',
          configPath: '[db.admin].PASSWORD',
          description: 'PostgreSQL admin password (use $ENV:VAR_NAME for secrets)',
        })
        pgPassword = ''
      } else {
        pgPassword = configPassword
      }
    } else {
      pgPassword = await password({ message: 'Enter PostgreSQL admin password:' })
    }

    const pgDatabase = await resolveOrPrompt(
      niCtx!,
      () => input({ message: 'Enter PostgreSQL database name:', default: 'postgres' }),
      resolveEnvValue(adminConfig.DATABASE) || 'postgres',
      {
        field: 'DATABASE',
        configPath: '[db.admin].DATABASE',
        description: 'PostgreSQL database name for admin connection',
      },
      false
    ) || 'postgres'

    return [publicHost, publicPort, pgUser, pgPassword, pgDatabase]
  }

  private async createConnection(host: string, port: string, user: string, password: string, database: string): Promise<pg.Client> {
    const conn = new pg.Client({
      host,
      port: parseInt(port),
      user,
      password,
      database,
      ssl: {
        rejectUnauthorized: false // Note: This is not secure for production use
      }
    })

    await conn.connect()
    return conn
  }
}