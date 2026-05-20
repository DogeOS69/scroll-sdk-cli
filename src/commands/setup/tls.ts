/* eslint-disable @typescript-eslint/no-explicit-any -- Dynamic YAML config operations */
import { confirm, input, select } from '@inquirer/prompts'
import { Command, Flags } from '@oclif/core'
import chalk from 'chalk'
import * as yaml from 'js-yaml'
import { exec } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { promisify } from 'node:util'

import { YAML_DUMP_OPTIONS } from '../../config/constants.js'
import { JsonOutputContext } from '../../utils/json-output.js'

const execAsync = promisify(exec)

export default class SetupTls extends Command {
  static override description = 'Update TLS configuration in Helm charts'

  static override examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> --debug',
    '<%= config.bin %> <%= command.id %> --values-dir custom-values',
    '<%= config.bin %> <%= command.id %> --non-interactive --cluster-issuer letsencrypt-prod',
    '<%= config.bin %> <%= command.id %> --non-interactive --json --cluster-issuer letsencrypt-prod',
    '<%= config.bin %> <%= command.id %> --non-interactive --create-issuer --issuer-email admin@example.com',
  ]

  static override flags = {
    'cluster-issuer': Flags.string({
      description: 'Specify the ClusterIssuer to use (for non-interactive mode)',
      required: false,
    }),
    'create-issuer': Flags.boolean({
      default: false,
      description: 'Create a letsencrypt-prod ClusterIssuer if none exists (for non-interactive mode)',
    }),
    debug: Flags.boolean({
      char: 'd',
      default: false,
      description: 'Show debug output and confirm before making changes',
    }),
    'issuer-email': Flags.string({
      description: 'Email address for the ClusterIssuer (required with --create-issuer)',
      required: false,
    }),
    'json': Flags.boolean({
      default: false,
      description: 'Output in JSON format (stdout for data, stderr for logs)',
    }),
    'non-interactive': Flags.boolean({
      char: 'N',
      default: false,
      description: 'Run without prompts. Requires --cluster-issuer or (--create-issuer with --issuer-email)',
    }),
    'values-dir': Flags.string({
      default: 'values',
      description: 'Directory containing the values files',
    }),
  }

  private debugMode: boolean = false
  private jsonCtx!: JsonOutputContext
  private jsonMode: boolean = false
  private nonInteractive: boolean = false
  private selectedIssuer: null | string = null
  private valuesDir: string = 'values'

  public async run(): Promise<void> {
    const { flags } = await this.parse(SetupTls)

    this.nonInteractive = flags['non-interactive']
    this.jsonMode = flags.json
    this.jsonCtx = new JsonOutputContext('setup tls', this.jsonMode)

    this.debugMode = flags.debug
    this.valuesDir = flags['values-dir']

    // In non-interactive mode, validate required flags
    if (this.nonInteractive) {
      if (!flags['cluster-issuer'] && !flags['create-issuer']) {
        this.jsonCtx.error(
          'E601_MISSING_FIELD',
          'Either --cluster-issuer or --create-issuer flag is required in non-interactive mode',
          'CONFIGURATION',
          true,
          { requiredFlags: ['--cluster-issuer', '--create-issuer'] }
        )
      }

      if (flags['create-issuer'] && !flags['issuer-email']) {
        this.jsonCtx.error(
          'E601_MISSING_FIELD',
          '--issuer-email flag is required when using --create-issuer',
          'CONFIGURATION',
          true,
          { flag: '--issuer-email' }
        )
      }
    }

    try {
      this.jsonCtx.info('Starting TLS configuration update...')

      let clusterIssuerExists = await this.checkClusterIssuer(flags['cluster-issuer'])

      while (!clusterIssuerExists) {
        if (this.nonInteractive) {
          // In non-interactive mode with --create-issuer flag
          if (flags['create-issuer']) {
            await this.createClusterIssuer(flags['issuer-email']!)
            this.selectedIssuer = 'letsencrypt-prod'
            clusterIssuerExists = true
          } else {
            this.jsonCtx.error(
              'E501_NO_CLUSTER_ISSUER',
              'No ClusterIssuer found and --create-issuer was not specified',
              'KUBERNETES',
              true
            )
          }
        } else {
          const createIssuer = await confirm({
            message: chalk.yellow('No suitable ClusterIssuer found. Do you want to create one?'),
          })

          if (createIssuer) {
            const email = await input({
              message: chalk.cyan('Enter your email address for the ClusterIssuer:'),
              validate(value) {
                if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
                  return 'Please enter a valid email address.'
                }

                return true
              },
            })

            await this.createClusterIssuer(email)
            clusterIssuerExists = await this.checkClusterIssuer()
          } else {
            this.jsonCtx.info('ClusterIssuer is required for TLS configuration. Exiting.')
            return
          }
        }
      }

      if (!this.selectedIssuer) {
        this.jsonCtx.error(
          'E501_NO_CLUSTER_ISSUER',
          'No ClusterIssuer selected. Exiting.',
          'KUBERNETES',
          true
        )
        // jsonCtx.error throws, so this is unreachable
      }

      this.jsonCtx.info(`Using ClusterIssuer: ${this.selectedIssuer}`)

      const chartsToUpdate = [
        'admin-system-dashboard',
        'frontends',
        'blockscout',
        'coordinator-api',
        'bridge-history-api',
        'rollup-explorer-backend',
        'l2-rpc',
        'l1-devnet',
        'scroll-monitor',
        'tso-service',
        'dogecoin',
        'blockbook'
      ]

      const updatedCharts: string[] = []
      const skippedCharts: string[] = []

      for (const chart of chartsToUpdate) {
        const updated = await this.updateChartIngress(chart, this.selectedIssuer)
        if (updated) {
          updatedCharts.push(chart)
        } else {
          skippedCharts.push(chart)
        }
      }

      this.jsonCtx.info('TLS configuration update completed.')

      // JSON success output
      this.jsonCtx.success({
        clusterIssuer: this.selectedIssuer,
        skippedCharts,
        updatedCharts,
        valuesDir: this.valuesDir
      })
    } catch (error) {
      this.jsonCtx.error(
        'E900_TLS_UPDATE_FAILED',
        `Failed to update TLS configuration: ${error}`,
        'INTERNAL',
        false,
        { error: String(error) }
      )
    }
  }

  private async checkClusterIssuer(specifiedIssuer?: string): Promise<boolean> {
    try {
      const { stdout } = await execAsync('kubectl get clusterissuer -o jsonpath="{.items[*].metadata.name}"')
      const clusterIssuers = stdout.trim().split(' ').filter(Boolean)

      if (clusterIssuers.length > 0) {
        this.jsonCtx.info('Found ClusterIssuer(s):')
        for (const issuer of clusterIssuers) this.jsonCtx.info(`  - ${issuer}`)

        // If a specific issuer was specified via flag, use it
        if (specifiedIssuer) {
          if (clusterIssuers.includes(specifiedIssuer)) {
            this.selectedIssuer = specifiedIssuer
            return true
          }
 
            this.jsonCtx.error(
              'E501_CLUSTER_ISSUER_NOT_FOUND',
              `Specified ClusterIssuer "${specifiedIssuer}" not found. Available: ${clusterIssuers.join(', ')}`,
              'KUBERNETES',
              true,
              { available: clusterIssuers, specifiedIssuer }
            )
          
        }

        // Non-interactive mode without specified issuer - use first one
        if (this.nonInteractive) {
          this.selectedIssuer = clusterIssuers[0]
          this.jsonCtx.info(`Using first available ClusterIssuer: ${this.selectedIssuer}`)
          return true
        }

        if (clusterIssuers.length === 1) {
          const useExisting = await confirm({
            message: chalk.yellow(`Do you want to use the existing ClusterIssuer "${clusterIssuers[0]}"?`),
          })
          if (useExisting) {
            this.selectedIssuer = clusterIssuers[0]
            return true
          }

          return false
        }
 
          this.selectedIssuer = await select({
            choices: clusterIssuers.map(issuer => ({ name: issuer, value: issuer })),
            message: chalk.yellow('Select which ClusterIssuer you want to use:'),
          })
          return true
        
      }
 
        this.jsonCtx.info('No ClusterIssuer found in the cluster.')
        return false
      
    } catch (error) {
      this.jsonCtx.info(`Error checking for ClusterIssuer: ${error}`)
      return false
    }
  }

  private async createClusterIssuer(email: string): Promise<void> {
    const clusterIssuerYaml = `
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: letsencrypt-prod
spec:
  acme:
    server: https://acme-v02.api.letsencrypt.org/directory
    email: ${email}
    privateKeySecretRef:
      name: letsencrypt-prod
    solvers:
      - http01:
          ingress:
            class: nginx
`

    try {
      await fs.promises.writeFile('cluster-issuer.yaml', clusterIssuerYaml)
      await execAsync('kubectl apply -f cluster-issuer.yaml')
      await fs.promises.unlink('cluster-issuer.yaml')
      this.jsonCtx.info('ClusterIssuer created successfully.')
    } catch (error) {
      this.jsonCtx.error(
        'E502_CLUSTER_ISSUER_CREATE_FAILED',
        `Failed to create ClusterIssuer: ${error}`,
        'KUBERNETES',
        false,
        { error: String(error) }
      )
    }
  }

  private async loadConfig(): Promise<any> {
    // TODO: Implement loading of config.yaml
  }

  // Handle charts that use the standard ingress TLS shape.
  private processStandardTls(yamlContent: any, chart: string, issuer: string): boolean {
    const {ingress} = yamlContent;
    let updated = false;

    // Add cert-manager annotation
    if (!ingress.annotations) {
      ingress.annotations = {};
    }

    if (ingress.annotations['cert-manager.io/cluster-issuer'] !== issuer) {
      ingress.annotations['cert-manager.io/cluster-issuer'] = issuer;
      updated = true;
    }

    // Handle TLS configuration
    if (ingress.tls && ingress.tls.length > 0) {
      ingress.tls.forEach((tlsConfig: any) => {
        for (let i = 0; i < ingress.hosts.length; i++) {
          if (tlsConfig.hosts[i] !== ingress.hosts[i].host) {
            tlsConfig.hosts[i] = ingress.hosts[i].host;
            updated = true;
          }
        }
      });
    } else {
      ingress.tls = [{
        hosts: [],
        secretName: `${chart}-tls`
      }];
      for (let i = 0; i < ingress.hosts.length; i++) {
        ingress.tls[0].hosts.push(ingress.hosts[i].host);
      }

      updated = true;
    }

    return updated;
  }

  private async updateChartIngress(chart: string, issuer: string): Promise<boolean> {
    const yamlPath = path.join(process.cwd(), this.valuesDir, `${chart}-production.yaml`)

    if (!fs.existsSync(yamlPath)) {
      this.jsonCtx.info(`${chart}-production.yaml not found in ${this.valuesDir} directory`)
      return false
    }

    try {
      const content = fs.readFileSync(yamlPath, 'utf8')
      const yamlContent: any = yaml.load(content)

      const ingressTypes = ['main', 'websocket']
      let updated = false


      /*
      grafana:
        ingress:
          enabled: true
          annotations:
            kubernetes.io/ingress.class: "nginx"
            nginx.ingress.kubernetes.io/ssl-redirect: "true"
          tls:
            - secretName: admin-system-dashboard-tls
              hosts:
                - grafana.scsdk.unifra.xyz
          hosts:
            - grafana.scsdk.unifra.xyz
      */
      if (yamlContent.grafana && yamlContent.grafana.ingress) {
        const originalContent = yaml.dump(yamlContent.grafana.ingress, YAML_DUMP_OPTIONS)
        let ingressUpdated = false;
        const {ingress} = yamlContent.grafana;
        if (!ingress.annotations) {
          ingress.annotations = {};
        }

        if (ingress.annotations['cert-manager.io/cluster-issuer'] !== issuer) {
          ingress.annotations['cert-manager.io/cluster-issuer'] = issuer
          ingressUpdated = true
        }


        // Update or add TLS configuration
        if (ingress.hosts && ingress.hosts.length > 0) {
          const firstHost = ingress.hosts[0];
          if (typeof firstHost === 'string') {
            const hostname = firstHost
            const secretName = `${chart}-grafana-tls`;
            // const secretName = ingressType === 'main' ? `${chart}-tls` : `${chart}-${ingressType}-tls`

            if (!ingress.tls) {
              ingress.tls = [{
                hosts: [hostname],
                secretName,
              }]
              ingressUpdated = true
            } else if (ingress.tls.length === 0) {
              ingress.tls.push({
                hosts: [hostname],
                secretName,
              })
              ingressUpdated = true
            } else {
              // Update existing TLS configuration
              ingress.tls.forEach((tlsConfig: any) => {
                if (!tlsConfig.secretName || tlsConfig.secretName !== secretName) {
                  tlsConfig.secretName = secretName
                  ingressUpdated = true
                }

                if (!tlsConfig.hosts || !tlsConfig.hosts.includes(hostname)) {
                  tlsConfig.hosts = [hostname]
                  ingressUpdated = true
                }
              })
            }
          }
        }

        if (ingressUpdated) {
          updated = true
          const updatedContent = yaml.dump(ingress, YAML_DUMP_OPTIONS)

          if (this.debugMode && !this.nonInteractive) {
            this.jsonCtx.info(`\nProposed changes for ${chart} :`)
            this.jsonCtx.info('- Original content:')
            this.jsonCtx.info(originalContent)
            this.jsonCtx.info('+ Updated content:')
            this.jsonCtx.info(updatedContent)

            const confirmUpdate = await confirm({
              message: chalk.cyan(`Do you want to apply these changes to ${chart}?`),
            })

            if (!confirmUpdate) {
              this.jsonCtx.info(`Skipped updating ${chart}`);
            }
          }

          this.jsonCtx.info(`Updated TLS configuration for ${chart} `)
        } else {
          this.jsonCtx.info(`No changes needed for ${chart} ()`)
        }

      }

      if (yamlContent["blockscout-stack"]) {

        const blockscoutStack = yamlContent["blockscout-stack"];
        const items = ["blockscout", "frontend"];
        for (const item of items) {
          if (blockscoutStack[item]?.ingress?.tls) {
            blockscoutStack[item].ingress.tls.enabled = true;
            updated = true;
          }
        }
      } else if (chart === "dogecoin") {
        if (yamlContent.ingress) {
          const dogecoinUpdated = this.processStandardTls(yamlContent, chart, issuer);
          if (dogecoinUpdated) {
            updated = true;
          }
        }
      } else if (chart === "blockbook" && yamlContent.ingress) {
          const blockbookUpdated = this.processStandardTls(yamlContent, chart, issuer);
          if (blockbookUpdated) {
            updated = true;
          }
        }

      for (const ingressType of ingressTypes) {
        if (yamlContent.ingress?.[ingressType]) {
          const originalContent = yaml.dump(yamlContent.ingress[ingressType], YAML_DUMP_OPTIONS)
          let ingressUpdated = false

          // Add or update annotation
          if (!yamlContent.ingress[ingressType].annotations) {
            yamlContent.ingress[ingressType].annotations = {}
          }

          if (yamlContent.ingress[ingressType].annotations['cert-manager.io/cluster-issuer'] !== issuer) {
            yamlContent.ingress[ingressType].annotations['cert-manager.io/cluster-issuer'] = issuer
            ingressUpdated = true
          }

          // Update or add TLS configuration
          if (yamlContent.ingress[ingressType].hosts && yamlContent.ingress[ingressType].hosts.length > 0) {
            const firstHost = yamlContent.ingress[ingressType].hosts[0]
            if (typeof firstHost === 'object' && firstHost.host) {
              const hostname = firstHost.host
              const secretName = ingressType === 'main' ? `${chart}-tls` : `${chart}-${ingressType}-tls`

              if (!yamlContent.ingress[ingressType].tls) {
                yamlContent.ingress[ingressType].tls = [{
                  hosts: [hostname],
                  secretName,
                }]
                ingressUpdated = true
              } else if (yamlContent.ingress[ingressType].tls.length === 0) {
                yamlContent.ingress[ingressType].tls.push({
                  hosts: [hostname],
                  secretName,
                })
                ingressUpdated = true
              } else {
                // Update existing TLS configuration
                yamlContent.ingress[ingressType].tls.forEach((tlsConfig: any) => {
                  if (!tlsConfig.secretName || tlsConfig.secretName !== secretName) {
                    tlsConfig.secretName = secretName
                    ingressUpdated = true
                  }

                  if (!tlsConfig.hosts || !tlsConfig.hosts.includes(hostname)) {
                    tlsConfig.hosts = [hostname]
                    ingressUpdated = true
                  }
                })
              }
            }
          }

          if (ingressUpdated) {
            updated = true
            const updatedContent = yaml.dump(yamlContent.ingress[ingressType], YAML_DUMP_OPTIONS)

            if (this.debugMode && !this.nonInteractive) {
              this.jsonCtx.info(`\nProposed changes for ${chart} (${ingressType}):`)
              this.jsonCtx.info('- Original content:')
              this.jsonCtx.info(originalContent)
              this.jsonCtx.info('+ Updated content:')
              this.jsonCtx.info(updatedContent)

              const confirmUpdate = await confirm({
                message: chalk.cyan(`Do you want to apply these changes to ${chart} (${ingressType})?`),
              })

              if (!confirmUpdate) {
                this.jsonCtx.info(`Skipped updating ${chart} (${ingressType})`)
                continue
              }
            }

            this.jsonCtx.info(`Updated TLS configuration for ${chart} (${ingressType})`)
          } else {
            this.jsonCtx.info(`No changes needed for ${chart} (${ingressType})`)
          }
        }
      }

      if (updated) {
        // Write updated YAML back to file
        const updatedYamlContent = yaml.dump(yamlContent, YAML_DUMP_OPTIONS)
        fs.writeFileSync(yamlPath, updatedYamlContent)
      }

      return updated
    } catch (error) {
      this.jsonCtx.info(`Failed to update ${chart}: ${error}`)
      return false
    }
  }
}
