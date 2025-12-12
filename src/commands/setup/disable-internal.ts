import { confirm } from '@inquirer/prompts'
import { Command, Flags } from '@oclif/core'
import chalk from 'chalk'
import Table from 'cli-table3'
import * as yaml from 'js-yaml'
import { exec } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { promisify } from 'node:util'

const execAsync = promisify(exec)

export default class SetupDisableInternal extends Command {
  static override description = 'Disable ingress for internal services (Celestia, Dogecoin, Anvil L1)'

  static override examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> --namespace scroll',
    '<%= config.bin %> <%= command.id %> --dry-run',
    '<%= config.bin %> <%= command.id %> --list',
    '<%= config.bin %> <%= command.id %> --list-k8s',
    '<%= config.bin %> <%= command.id %> --enable l2-rpc',
    '<%= config.bin %> <%= command.id %> --disable frontends',
  ]

  static override flags = {
    disable: Flags.string({
      description: 'Disable ingress for a service',
      exclusive: ['list', 'enable', 'disable-internal']
    }),
    'disable-internal': Flags.boolean({
      default: false,
      description: 'Disable all internal services (Celestia, Dogecoin, Anvil L1) using kubectl',
      exclusive: ['list', 'enable', 'disable']
    }),
    'dry-run': Flags.boolean({
      default: false,
      description: 'Show what would be deleted without actually deleting'
    }),
    enable: Flags.string({
      description: 'Enable ingress for a service',
      exclusive: ['list', 'disable', 'disable-internal']
    }),
    force: Flags.boolean({
      char: 'f',
      default: false,
      description: 'Skip confirmation prompts'
    }),
    list: Flags.boolean({
      description: 'List current ingress status from local values files',
      exclusive: ['enable', 'disable', 'disable-internal', 'list-k8s']
    }),
    'list-k8s': Flags.boolean({
      description: 'List current ingress status from Kubernetes cluster',
      exclusive: ['enable', 'disable', 'disable-internal', 'list']
    }),
    namespace: Flags.string({
      char: 'n',
      default: 'default',
      description: 'Kubernetes namespace'
    }),
    'skip-helm': Flags.boolean({
      default: false,
      description: 'Skip helm upgrade'
    }),
    'values-dir': Flags.string({
      default: './values',
      description: 'Directory containing values files'
    })
  }

  // Internal services that should not be exposed
  private readonly INTERNAL_SERVICES = [
    'celestia-node',
    'celestia-testnet',
    'celestia-mainnet',
    'dogecoin',
    'l1-devnet'
  ]

  public async run(): Promise<void> {
    const { flags } = await this.parse(SetupDisableInternal)

    // Handle list-k8s flag
    if (flags['list-k8s']) {
      await this.listK8sIngresses(flags.namespace)
      return
    }

    // Handle disable-internal flag (new default behavior)
    if (flags['disable-internal'] || (!flags.list && !flags.enable && !flags.disable)) {
      await this.disableInternalWithKubectl(flags.namespace, flags['dry-run'], flags.force)
      return
    }

    if (flags.list) {
      await this.listStatus(flags['values-dir'])
      return
    }

    if (flags.enable) {
      const services = flags.enable.split(',').map(s => s.trim())
      for (const service of services) {
        await this.toggleIngress(
          service, 
          true, 
          flags['values-dir'],
          flags['skip-helm']
        )
      }

      return
    }

    if (flags.disable) {
      const services = flags.disable.split(',').map(s => s.trim())
      for (const service of services) {
        await this.toggleIngress(
          service, 
          false, 
          flags['values-dir'],
          flags['skip-helm']
        )
      }
      
    }
  }

  private async disableInternalWithKubectl(namespace: string, dryRun: boolean, force: boolean = false): Promise<void> {
    this.log(chalk.bold(`Disabling ingress for internal services in namespace: ${namespace}`))
    this.log(chalk.gray('Internal services: Celestia, Dogecoin, Anvil L1\n'))

    // First, list current ingresses
    try {
      const { stdout } = await execAsync(`kubectl get ingress -n ${namespace} -o name`)
      const ingresses = stdout.trim().split('\n').filter(Boolean)
      
      const internalIngresses = ingresses.filter(ingress => {
        const name = ingress.replace('ingress.networking.k8s.io/', '')
        return this.INTERNAL_SERVICES.some(service => 
          name.includes(service) || 
          name.includes('celestia') || 
          name.includes('dogecoin') || 
          name.includes('l1-devnet')
        )
      })

      if (internalIngresses.length === 0) {
        this.log(chalk.yellow('No internal service ingresses found'))
        return
      }

      this.log(chalk.cyan('Found internal service ingresses:'))
      for (const ingress of internalIngresses) {
        this.log(chalk.gray(`  - ${ingress.replace('ingress.networking.k8s.io/', '')}`))
      }

      // Prepare delete commands
      const deleteCommands = internalIngresses.map(ingress => {
        const name = ingress.replace('ingress.networking.k8s.io/', '')
        return `kubectl delete ingress ${name} -n ${namespace}`
      })

      if (dryRun) {
        this.log(chalk.yellow('\nDry run mode - would execute:'))
        for (const cmd of deleteCommands) {
          this.log(chalk.gray(`  $ ${cmd}`))
        }

        return
      }

      // Execute delete commands with confirmation
      this.log(chalk.cyan('\nPreparing to delete ingresses...'))
      for (const cmd of deleteCommands) {
        const name = cmd.match(/delete ingress (\S+)/)?.[1] || 'unknown'
        
        this.log(chalk.blue(`\nCommand to execute:`))
        this.log(chalk.gray(`  $ ${cmd}`))
        
        const confirmed = force || await confirm({
          default: true,
          message: `Delete ingress '${name}'?`
        })

        if (confirmed) {
          try {
            await execAsync(cmd)
            this.log(chalk.green(`✓ Deleted ingress: ${name}`))
          } catch (error: any) {
            this.warn(chalk.red(`✗ Failed to delete ${name}: ${error.message}`))
          }
        } else {
          this.log(chalk.yellow(`⏭  Skipped ${name}`))
        }
      }

    } catch {
      // Try alternative approach with predefined service names
      this.log(chalk.yellow('Using predefined service names...'))
      
      const deleteCommands = this.INTERNAL_SERVICES.map(service => 
        `kubectl delete ingress ${service} -n ${namespace} --ignore-not-found=true`
      )

      if (dryRun) {
        this.log(chalk.yellow('\nDry run - would execute:'))
        for (const cmd of deleteCommands) this.log(chalk.gray(`  $ ${cmd}`))
        return
      }

      this.log(chalk.cyan('\nAttempting to delete using predefined service names...'))
      for (const cmd of deleteCommands) {
        const serviceName = cmd.match(/delete ingress (\S+)/)?.[1] || 'unknown'
        
        this.log(chalk.blue(`\nCommand to execute:`))
        this.log(chalk.gray(`  $ ${cmd}`))
        
        const confirmed = force || await confirm({
          default: true,
          message: `Attempt to delete ingress '${serviceName}'?`
        })

        if (confirmed) {
          try {
            const { stderr } = await execAsync(cmd)
            if (stderr && !stderr.includes('NotFound')) {
              this.warn(chalk.yellow(stderr))
            } else if (!stderr || stderr.includes('NotFound')) {
              this.log(chalk.gray(`  No ingress found for ${serviceName}`))
            }
          } catch (error: any) {
            this.warn(chalk.red(`Error: ${error.message}`))
          }
        } else {
          this.log(chalk.yellow(`⏭  Skipped ${serviceName}`))
        }
      }
    }

    // Verify deletion
    try {
      const verifyCmd = `kubectl get ingress -n ${namespace} -o name | grep -E "(celestia|dogecoin|l1-devnet)" || true`
      this.log(chalk.cyan('\nVerifying deletion...'))
      this.log(chalk.gray(`  $ ${verifyCmd}`))
      
      const { stdout } = await execAsync(verifyCmd)
      if (stdout.trim()) {
        this.warn(chalk.yellow('\nSome internal ingresses may still exist:'))
        this.log(stdout)
      } else {
        this.log(chalk.green('\n✅ All internal service ingresses have been disabled'))
      }
    } catch {
      // Ignore errors in verification
    }
  }

  private async getServices(valuesDir: string): Promise<Map<string, any>> {
    const services = new Map<string, any>()
    
    const files = fs.readdirSync(valuesDir)
      .filter(file => file.endsWith('-production.yaml'))

    for (const file of files) {
      const serviceName = file.replace(/-production\.yaml$/, '')
      const filePath = path.join(valuesDir, file)
      
      try {
        const content = fs.readFileSync(filePath, 'utf8')
        const data = yaml.load(content) as any
        
        services.set(serviceName, {
          data,
          file,
          ingressEnabled: this.isIngressEnabled(data)
        })
      } catch {
        this.warn(`Failed to read ${file}`)
      }
    }

    return services
  }

  private isIngressEnabled(data: any): boolean {
    // Simple check for ingress.enabled
    if (data.ingress?.enabled !== undefined) {
      return data.ingress.enabled
    }
    
    // Special case for blockscout
    if (data['blockscout-stack']) {
      return data['blockscout-stack'].blockscout?.ingress?.enabled || 
             data['blockscout-stack'].frontend?.ingress?.enabled || false
    }
    
    // Special case for grafana
    if (data.grafana?.ingress?.enabled !== undefined) {
      return data.grafana.ingress.enabled
    }
    
    return false
  }

  private async listK8sIngresses(namespace: string): Promise<void> {
    this.log(chalk.bold(`Ingress Status in Kubernetes (namespace: ${namespace}):`))
    
    try {
      // Get all ingresses in the namespace
      const { stdout } = await execAsync(`kubectl get ingress -n ${namespace} -o json`)
      const ingressData = JSON.parse(stdout)
      
      if (!ingressData.items || ingressData.items.length === 0) {
        this.log(chalk.yellow('No ingresses found in this namespace'))
        return
      }

      const table = new Table({
        head: ['Service', 'Hosts', 'Class', 'Address'],
        style: { head: ['cyan'] }
      })

      for (const ingress of ingressData.items) {
        const {name} = ingress.metadata
        const hosts = ingress.spec.rules?.map((r: any) => r.host).filter(Boolean).join(', ') || '-'
        const className = ingress.spec.ingressClassName || 'default'
        const addresses = ingress.status.loadBalancer?.ingress?.map((i: any) => 
          i.hostname || i.ip || '-'
        ).join(', ') || 'Pending'
        
        // Highlight internal services
        const isInternal = this.INTERNAL_SERVICES.some(service => 
          name.includes(service) || 
          name.includes('celestia') || 
          name.includes('dogecoin') || 
          name.includes('l1-devnet')
        )
        
        const displayName = isInternal ? chalk.yellow(`${name} ⚠`) : name
        
        table.push([displayName, hosts, className, addresses])
      }

      this.log(table.toString())
      
      // Count internal services
      const internalCount = ingressData.items.filter((ingress: any) => {
        const {name} = ingress.metadata
        return this.INTERNAL_SERVICES.some(service => 
          name.includes(service) || 
          name.includes('celestia') || 
          name.includes('dogecoin') || 
          name.includes('l1-devnet')
        )
      }).length

      if (internalCount > 0) {
        this.log(chalk.yellow(`\n⚠  ${internalCount} internal service(s) have ingress enabled`))
      }

    } catch (error: any) {
      if (error.message.includes('command not found')) {
        this.error('kubectl is not installed or not in PATH')
      }

      this.error(`Failed to get ingresses: ${error.message}`)
    }
  }

  private async listStatus(valuesDir: string): Promise<void> {
    const services = await this.getServices(valuesDir)

    const table = new Table({
      head: ['Service', 'Ingress Status'],
      style: { head: ['cyan'] }
    })

    for (const [name, info] of services) {
      const status = info.ingressEnabled 
        ? chalk.green('✓ Enabled') 
        : chalk.gray('✗ Disabled')
      table.push([name, status])
    }

    this.log('\n' + chalk.bold('Ingress Status:'))
    this.log(table.toString())
  }

  private async runHelmUpgrade(serviceName: string): Promise<void> {
    this.log(chalk.cyan(`Running helm upgrade for ${serviceName}...`))
    
    try {
      // Try to run make install command
      const makeCommand = `make install-${serviceName}`
      const { stderr } = await execAsync(makeCommand)
      
      if (stderr) {
        this.warn(chalk.yellow(stderr))
      }
      
      this.log(chalk.green(`✓ Helm upgrade completed for ${serviceName}`))
    } catch (error: any) {
      this.warn(chalk.yellow(`Failed to run helm upgrade: ${error.message}`))
      this.log(chalk.gray(`Run manually: make install-${serviceName}`))
    }
  }

  private async toggleIngress(
    serviceName: string, 
    enable: boolean, 
    valuesDir: string,
    skipHelm: boolean
  ): Promise<void> {
    const services = await this.getServices(valuesDir)
    const service = services.get(serviceName)

    if (!service) {
      this.error(`Service '${serviceName}' not found`)
    }

    const filePath = path.join(valuesDir, service.file)
    const {data} = service

    // Update ingress configuration
    if (serviceName === 'blockscout' && data['blockscout-stack']) {
      // Special handling for blockscout
      if (data['blockscout-stack'].blockscout?.ingress) {
        data['blockscout-stack'].blockscout.ingress.enabled = enable
      }

      if (data['blockscout-stack'].frontend?.ingress) {
        data['blockscout-stack'].frontend.ingress.enabled = enable
      }
    } else if (serviceName === 'grafana' && data.grafana) {
      // Special handling for grafana
      if (!data.grafana.ingress) {
        data.grafana.ingress = {}
      }

      data.grafana.ingress.enabled = enable
    } else {
      // Regular services
      if (!data.ingress) {
        data.ingress = {}
      }

      data.ingress.enabled = enable
    }

    // Save the file
    const yamlStr = yaml.dump(data, { 
      indent: 2,
      lineWidth: -1,
      noRefs: true
    })
    fs.writeFileSync(filePath, yamlStr)

    this.log(chalk.green(`✓ Updated ${service.file}`))
    this.log(chalk.gray(`  Ingress ${enable ? 'enabled' : 'disabled'} for ${serviceName}`))

    // Run helm upgrade if not skipped
    if (!skipHelm) {
      await this.runHelmUpgrade(serviceName)
    }
  }
}