import * as fs from 'fs'
import * as path from 'path'
import { promisify } from 'util'
import { exec } from 'child_process'
import * as yaml from 'js-yaml'
import { input } from '@inquirer/prompts'
import chalk from 'chalk'
import { YAML_DUMP_OPTIONS } from '../config/constants.js'
import { executeCommand } from '../utils/command-executor.js'

const execAsync = promisify(exec)

export interface NodeStaticIPProvider {
  checkPrerequisites(): Promise<boolean>
  setupStaticIP(flags: any, bootnodeCount: number): Promise<string[]>
}

export class AWSNodeStaticIPProvider implements NodeStaticIPProvider {
  private region: string;
  private clusterName: string;
  private accountId: string;

  constructor(region?: string, clusterName?: string, accountId?: string) {
    this.region = region || '';
    this.clusterName = clusterName || '';
    this.accountId = accountId || '';
  }

  async checkPrerequisites(): Promise<boolean> {
    const commands = [
      { cmd: 'aws --version', name: 'AWS CLI' },
      { cmd: 'eksctl version', name: 'eksctl' },
      { cmd: 'kubectl version --client', name: 'kubectl' },
      { cmd: 'helm version', name: 'Helm' }
    ];

    console.log(chalk.blue('Checking AWS prerequisites...'));

    for (const { cmd, name } of commands) {
      try {
        await executeCommand(cmd, false);
        console.log(chalk.green(`✓ ${name} is installed`));
      } catch (error) {
        console.log(chalk.red(`✗ ${name} is not installed or not in PATH`));
        return false;
      }
    }

    try {
      await executeCommand('aws sts get-caller-identity', false);
      console.log(chalk.green('✓ AWS credentials configured'));
    } catch (error) {
      console.log(chalk.red('✗ AWS credentials not configured, please run "aws configure"'));
      return false;
    }

    console.log(chalk.green('All AWS prerequisites met!'));
    return true;
  }

  async setupStaticIP(flags: any, bootnodeCount: number): Promise<string[]> {
    console.log(chalk.blue('Starting AWS P2P Static IP Setup...'));
    console.log('====================================');

    if (!flags['cluster-name']) {
      this.clusterName = await input({ message: 'Enter your EKS cluster name:' });
      if (!this.clusterName) {
        throw new Error('Cluster name cannot be empty');
      }
    } else {
      this.clusterName = flags['cluster-name'];
    }

    if (!flags.region) {
      this.region = await input({ message: 'Enter your AWS region (e.g., us-east-2):' });
      if (!this.region) {
        throw new Error('AWS region cannot be empty');
      }
    } else {
      this.region = flags.region;
    }

    console.log('Verifying cluster exists...');
    const clusterExists = await this.verifyClusterExists(this.clusterName, this.region);
    if (!clusterExists) {
      throw new Error(`Cluster '${this.clusterName}' not found in region '${this.region}'`);
    }

    this.accountId = await this.getAwsAccountId();

    console.log('Configuration:');
    console.log(`  Cluster: ${this.clusterName}`);
    console.log(`  Region: ${this.region}`);
    console.log(`  Account ID: ${this.accountId}`);
    console.log('');

    try {
      await this.configureIamPermissions(this.accountId);
      await this.installLoadBalancerController(this.clusterName, this.region);
      console.log(chalk.blue(`Setting up static IPs for ${bootnodeCount} bootnode(s)`))
      //const allocationIds = await this.createElasticIPs(this.region, bootnodeCount);
      const allocationIds: string[] = [];
      const valuesDir = flags['values-dir']
      await this.updateProductionFilesWithEips(allocationIds, valuesDir, bootnodeCount, this.region, this.clusterName);

      const verificationPassed = await this.verifyAwsSetup(this.accountId, this.region, bootnodeCount);
      if (verificationPassed) {
        console.log(chalk.green('🚀 AWS P2P setup completed successfully!'));
      } else {
        console.log(chalk.yellow('⚠️  AWS P2P setup completed with warnings - some verification checks failed'));
        console.log(chalk.yellow('💡 You may need to troubleshoot the failed components before deployment'));
        throw new Error('AWS P2P setup failed');
      }

      console.log(chalk.blue('📋 Retrieving static IP addresses...'));
      const staticIPs: string[] = [];

      for (let i = 0; i < bootnodeCount; i++) {
        const eipName = `bootnode-${i}-p2p`;
        try {
          const { stdout: ipAddress } = await executeCommand(`aws ec2 describe-addresses \
            --filters "Name=tag:Name,Values=${eipName}" \
            --query "Addresses[0].PublicIp" \
            --output text \
            --region "${this.region}"`, false);

          const ip = ipAddress.trim();
          if (ip && ip !== 'None' && ip !== 'null') {
            staticIPs.push(ip);
            console.log(chalk.green(`✓ Static IP for bootnode-${i}: ${ip}`));
          } else {
            console.log(chalk.yellow(`⚠️  Static IP for bootnode-${i}: Not found`));
            staticIPs.push(''); // placeholder for failed retrieval
          }
        } catch (error) {
          console.log(chalk.yellow(`⚠️  Could not retrieve IP for bootnode-${i}: ${error instanceof Error ? error.message : String(error)}`));
          staticIPs.push(''); // placeholder for failed retrieval
        }
      }

      console.log('');
      const ns = flags.namespace || 'default';
      console.log(chalk.blue('💡 To get LoadBalancer domains after deployment:'));
      for (let i = 0; i < bootnodeCount; i++) {
        console.log(chalk.blue(`  kubectl get service l2-bootnode-${i}-p2p -n ${ns} -o jsonpath='{.status.loadBalancer.ingress[0].hostname}'`));
      }
      return staticIPs;
    } catch (error) {
      console.log(chalk.red('Error occurred during AWS setup:'));
      console.log(chalk.red(error instanceof Error ? error.message : String(error)));
      throw new Error('AWS P2P static IP setup failed');
    }
  }

  private async verifyClusterExists(clusterName: string, region: string): Promise<boolean> {
    try {
      await executeCommand(`aws eks describe-cluster --name "${clusterName}" --region "${region}"`, false);
      return true;
    } catch (error) {
      return false;
    }
  }

  private async getAwsAccountId(): Promise<string> {
    const { stdout } = await executeCommand('aws sts get-caller-identity --query "Account" --output text', false);
    return stdout.trim();
  }

  private async installLoadBalancerController(clusterName: string, region: string): Promise<void> {

    console.log('Adding EKS Helm repository...');
    await executeCommand('helm repo add eks https://aws.github.io/eks-charts');
    await executeCommand('helm repo update');

    const { stdout: vpcId } = await executeCommand(`aws eks describe-cluster --name "${clusterName}" --region "${region}" --query "cluster.resourcesVpcConfig.vpcId" --output text`, false);

    console.log('Installing AWS Load Balancer Controller...');
    try {
      await executeCommand('helm list -n kube-system | grep aws-load-balancer-controller', false);
      console.log(chalk.yellow('AWS Load Balancer Controller already installed, upgrading...'));
      await executeCommand(`helm upgrade aws-load-balancer-controller eks/aws-load-balancer-controller \
        -n kube-system \
        --set clusterName="${clusterName}" \
        --set serviceAccount.create=false \
        --set serviceAccount.name=aws-load-balancer-controller \
        --set region="${region}" \
        --set vpcId="${vpcId.trim()}"`);
    } catch (error) {
      console.log('Installing AWS Load Balancer Controller...');
      try {
        await executeCommand(`helm install aws-load-balancer-controller eks/aws-load-balancer-controller \
          -n kube-system \
          --set clusterName="${clusterName}" \
          --set serviceAccount.create=false \
          --set serviceAccount.name=aws-load-balancer-controller \
          --set region="${region}" \
          --set vpcId="${vpcId.trim()}"`);
      } catch (installError) {
        console.log(chalk.yellow('Installation failed, attempting cleanup and retry...'));
        try {
          await executeCommand('helm uninstall aws-load-balancer-controller -n kube-system', true);
          console.log('Cleaned up failed installation, retrying...');
          await executeCommand(`helm install aws-load-balancer-controller eks/aws-load-balancer-controller \
            -n kube-system \
            --set clusterName="${clusterName}" \
            --set serviceAccount.create=false \
            --set serviceAccount.name=aws-load-balancer-controller \
            --set region="${region}" \
            --set vpcId="${vpcId.trim()}"`);
        } catch (retryError) {
          throw new Error(`Failed to install AWS Load Balancer Controller after cleanup: ${retryError instanceof Error ? retryError.message : String(retryError)}`);
        }
      }
    }


    console.log('Waiting for AWS Load Balancer Controller to be ready...');

    try {
      await executeCommand('kubectl wait --for=condition=available --timeout=180s deployment/aws-load-balancer-controller -n kube-system', false);
    } catch (error) {
      console.log(chalk.yellow('Deployment not ready within timeout, checking pod status...'));

      try {
        const { stdout } = await executeCommand('kubectl get pods -n kube-system -l app.kubernetes.io/name=aws-load-balancer-controller -o jsonpath="{.items[*].status.phase}"', false);
        const { stdout: podNames } = await executeCommand('kubectl get pods -n kube-system -l app.kubernetes.io/name=aws-load-balancer-controller -o jsonpath="{.items[*].metadata.name}"', false);

        console.log(`Pod statuses: ${stdout}`);

        const pods = podNames.split(' ').filter(name => name);
        for (const pod of pods) {
          try {
            const { stdout: logs } = await executeCommand(`kubectl logs ${pod} -n kube-system --tail=5`, false);
            if (logs.includes('Unauthorized') || logs.includes('unable to create controller')) {
              throw new Error(`AWS Load Balancer Controller pod ${pod} has permission issues. This usually indicates the IAM service account was not created properly.`);
            }
          } catch (logError) {
          }
        }
      } catch (debugError) {
      }

      throw new Error('AWS Load Balancer Controller failed to become ready within timeout');
    }

    try {
      const { stdout } = await executeCommand('kubectl get pods -n kube-system -l app.kubernetes.io/name=aws-load-balancer-controller --field-selector=status.phase=Running --no-headers | wc -l', false);
      const runningPods = parseInt(stdout.trim());
      if (runningPods === 0) {
        throw new Error('No AWS Load Balancer Controller pods are running');
      }
      console.log(chalk.green(`✓ ${runningPods} AWS Load Balancer Controller pod(s) running`));
    } catch (error) {
      throw new Error('Failed to verify AWS Load Balancer Controller pod status');
    }

    console.log(chalk.green('AWS Load Balancer Controller installed successfully!'));
  }

  private async restartLoadBalancerController(): Promise<void> {
    console.log('Restarting AWS Load Balancer Controller to apply new permissions...');
    try {
      await executeCommand('kubectl rollout restart deployment/aws-load-balancer-controller -n kube-system');
      console.log(chalk.green('✓ AWS Load Balancer Controller restarted to apply new permissions'));

      try {
        await executeCommand('kubectl wait --for=condition=available --timeout=120s deployment/aws-load-balancer-controller -n kube-system', false);
        console.log(chalk.green('✓ AWS Load Balancer Controller is ready after restart'));
      } catch (waitError) {
        console.log(chalk.yellow('⚠️  Load Balancer Controller restart may still be in progress'));
      }
    } catch (restartError) {
      console.log(chalk.yellow(`⚠️  Could not restart Load Balancer Controller: ${restartError instanceof Error ? restartError.message : String(restartError)}`));
    }
  }

  private async configureIamPermissions(accountId: string): Promise<void> {
    const lbcPolicyName = 'AWSLoadBalancerControllerIAMPolicy';

    // Check if OIDC provider is already associated
    console.log(chalk.blue('Checking OIDC provider association...'));
    try {
      const { stdout: oidcIssuer } = await executeCommand(`aws eks describe-cluster --name "${this.clusterName}" --region "${this.region}" --query "cluster.identity.oidc.issuer" --output text`, false);
      if (oidcIssuer && oidcIssuer !== 'None') {
        const issuerHost = oidcIssuer.replace('https://', '');
        const { stdout: existingProviders } = await executeCommand(`aws iam list-open-id-connect-providers --query "OpenIDConnectProviderList[?contains(Arn, '${issuerHost}')].Arn" --output text`, false);

        if (existingProviders.trim()) {
          console.log(chalk.green('✓ OIDC provider already associated'));
        } else {
          console.log('Associating OIDC provider...');
          const cmd = `eksctl utils associate-iam-oidc-provider --region=${this.region} --cluster=${this.clusterName} --approve`;
          const result = await executeCommand(cmd);
          console.log(result);
        }
      }
    } catch (error) {
      console.log('Attempting to associate OIDC provider...');
      const cmd = `eksctl utils associate-iam-oidc-provider --region=${this.region} --cluster=${this.clusterName} --approve`;
      try {
        const result = await executeCommand(cmd);
        console.log(result);
      } catch (associateError) {
        console.log(chalk.red('✗ IAM OIDC provider association failed'));
        throw associateError;
      }
    }

    console.log(chalk.blue(`Checking if ${lbcPolicyName} already exists...`));
    const { stdout: existingLbcPolicyArn } = await executeCommand(
      `aws iam list-policies --scope Local --query "Policies[?PolicyName=='${lbcPolicyName}'].Arn | [0]" --output text`,
      false
    );

    if (existingLbcPolicyArn && existingLbcPolicyArn.trim() && existingLbcPolicyArn.trim() !== 'None') {
      console.log(chalk.yellow(`${lbcPolicyName} already exists`));
    } else {
      try {
        console.log('Downloading official AWS Load Balancer Controller IAM policy...');
        const policyUrl = 'https://raw.githubusercontent.com/kubernetes-sigs/aws-load-balancer-controller/v2.13.0/docs/install/iam_policy.json';
        const tempPolicyPath = '/tmp/aws-load-balancer-controller-policy.json';

        await executeCommand(`curl -s -o "${tempPolicyPath}" "${policyUrl}"`, false);
        console.log(chalk.green('✓ Downloaded official policy'));

        await executeCommand(`aws iam create-policy \
          --policy-name "${lbcPolicyName}" \
          --policy-document file://${tempPolicyPath} \
          --description "IAM policy for AWS Load Balancer Controller"`);
        console.log(chalk.green(`✓ Created policy '${lbcPolicyName}'`));

        if (fs.existsSync(tempPolicyPath)) {
          fs.unlinkSync(tempPolicyPath);
        }
      } catch (createError) {
        if (createError instanceof Error && createError.message.includes('EntityAlreadyExists')) {
          console.log(chalk.yellow(`Policy '${lbcPolicyName}' already exists, skipping creation`));
        } else {
          throw createError;
        }
      }
    }

    // Create EKSElasticIPManagement policy for node groups
    console.log('Setting up EKS Elastic IP Management policy...');
    const eksElasticIPPolicyName = 'EKSElasticIPManagement';

    try {
      const { stdout: existingEksElasticPolicyArn } = await executeCommand(
        `aws iam list-policies --scope Local --query "Policies[?PolicyName=='${eksElasticIPPolicyName}'].Arn | [0]" --output text`,
        false
      );

      if (!existingEksElasticPolicyArn || existingEksElasticPolicyArn.trim() === '' || existingEksElasticPolicyArn.trim() === 'None') {
        console.log(`Creating ${eksElasticIPPolicyName} policy...`);
        const eksElasticIPPolicyDocument = {
          "Version": "2012-10-17",
          "Statement": [
            {
              "Effect": "Allow",
              "Action": [
                "ec2:AllocateAddress",
                "ec2:AssociateAddress",
                "ec2:DescribeAddresses",
                "ec2:DisassociateAddress",
                "ec2:ReleaseAddress",
                "ec2:DescribeInstances",
                "ec2:DescribeNetworkInterfaces",
                "ec2:DescribeSubnets",
                "ec2:DescribeRouteTables",
                "ec2:CreateTags",
                "ec2:DescribeTags"
              ],
              "Resource": "*"
            }
          ]
        };

        const tempEksElasticIPPolicyPath = '/tmp/eks-elastic-ip-policy.json';
        fs.writeFileSync(tempEksElasticIPPolicyPath, JSON.stringify(eksElasticIPPolicyDocument, null, 2));

        await executeCommand(`aws iam create-policy \
          --policy-name "${eksElasticIPPolicyName}" \
          --policy-document file://${tempEksElasticIPPolicyPath} \
          --description "IAM policy for EKS Elastic IP Management"`);
        console.log(chalk.green(`✓ Created policy '${eksElasticIPPolicyName}'`));

        if (fs.existsSync(tempEksElasticIPPolicyPath)) {
          fs.unlinkSync(tempEksElasticIPPolicyPath);
        }
      } else {
        console.log(chalk.green(`✓ Policy '${eksElasticIPPolicyName}' already exists, skipping creation`));
      }
    } catch (createEksElasticIPError) {
      if (createEksElasticIPError instanceof Error && createEksElasticIPError.message.includes('EntityAlreadyExists')) {
        console.log(chalk.yellow(`Policy '${eksElasticIPPolicyName}' already exists, skipping creation`));
      } else {
        console.log(chalk.yellow(`⚠️  Failed to create ${eksElasticIPPolicyName} policy: ${createEksElasticIPError instanceof Error ? createEksElasticIPError.message : String(createEksElasticIPError)}`));
      }
    }

    // Create IAM service account for AWS Load Balancer Controller FIRST
    // This will create the role automatically
    console.log('Setting up IAM service account for AWS Load Balancer Controller...');
    const roleName = 'AmazonEKSLoadBalancerControllerRole';
    const serviceAccountName = 'aws-load-balancer-controller';

    try {
      await executeCommand(`kubectl get serviceaccount ${serviceAccountName} -n kube-system`, false);

      // Verify the service account has the correct IAM role annotation
      const { stdout: roleArn } = await executeCommand(`kubectl get serviceaccount ${serviceAccountName} -n kube-system -o jsonpath="{.metadata.annotations.eks\\.amazonaws\\.com/role-arn}"`, false);

      if (roleArn && roleArn.includes(roleName)) {
        console.log(chalk.green('✓ AWS Load Balancer Controller service account already exists and is properly configured'));
      } else {
        console.log(chalk.yellow('⚠️  Service account exists but lacks proper IAM role, recreating...'));
        await executeCommand(`eksctl delete iamserviceaccount --cluster="${this.clusterName}" --namespace=kube-system --name=aws-load-balancer-controller`);
        await new Promise(resolve => setTimeout(resolve, 5000)); // Wait for deletion
        throw new Error('Need to recreate service account');
      }
    } catch (error) {
      console.log('Creating IAM service account for AWS Load Balancer Controller...');
      await executeCommand(`eksctl create iamserviceaccount \
        --cluster="${this.clusterName}" \
        --namespace=kube-system \
        --name=${serviceAccountName} \
        --role-name="${roleName}" \
        --attach-policy-arn=arn:aws:iam::aws:policy/ElasticLoadBalancingFullAccess \
        --approve \
        --region="${this.region}" \
        --timeout=15m`);
      console.log(chalk.green('✓ IAM service account created'));
    }

    // NOW attach additional policies to the role (role exists now)
    console.log('Ensuring AWS Load Balancer Controller has required permissions...');

    try {
      await executeCommand(`aws iam attach-role-policy \
        --role-name "${roleName}" \
        --policy-arn "arn:aws:iam::${accountId}:policy/${lbcPolicyName}"`);
      console.log(chalk.green(`✓ Attached policy '${lbcPolicyName}' to role`));
    } catch (error) {
      if (error instanceof Error && error.message.includes('EntityAlreadyExists')) {
        console.log(chalk.yellow(`⚠️  Policy '${lbcPolicyName}' may already be attached to role`));
      } else {
        console.log(chalk.yellow(`⚠️  Failed to attach policy '${lbcPolicyName}': ${error instanceof Error ? error.message : String(error)}`));
      }
    }

    // Attach EKSElasticIPManagement policy to node group roles
    console.log('Attaching EKS Elastic IP Management policy to node group roles...');
    try {
      const { stdout: nodeGroups } = await executeCommand(`aws eks list-nodegroups --cluster-name "${this.clusterName}" --region "${this.region}" --query "nodegroups" --output text`, false);

      if (nodeGroups && nodeGroups.trim() !== 'None') {
        const nodeGroupList = nodeGroups.trim().split(/\s+/);

        for (const nodeGroupName of nodeGroupList) {
          try {
            const { stdout: nodeGroupInfo } = await executeCommand(`aws eks describe-nodegroup --cluster-name "${this.clusterName}" --nodegroup-name "${nodeGroupName}" --region "${this.region}" --query "nodegroup.nodeRole" --output text`, false);

            if (nodeGroupInfo && nodeGroupInfo.trim() !== 'None') {
              const nodeRoleArn = nodeGroupInfo.trim();
              const nodeRoleName = nodeRoleArn.split('/').pop();

              if (nodeRoleName) {
                try {
                  await executeCommand(`aws iam attach-role-policy \
                    --role-name "${nodeRoleName}" \
                    --policy-arn "arn:aws:iam::${accountId}:policy/${eksElasticIPPolicyName}"`);
                  console.log(chalk.green(`✓ Attached ${eksElasticIPPolicyName} to node group role: ${nodeRoleName}`));
                } catch (attachError) {
                  console.log(chalk.yellow(`⚠️  ${eksElasticIPPolicyName} may already be attached to role: ${nodeRoleName}`));
                }
              }
            }
          } catch (nodeGroupError) {
            console.log(chalk.yellow(`⚠️  Could not process node group ${nodeGroupName}: ${nodeGroupError instanceof Error ? nodeGroupError.message : String(nodeGroupError)}`));
          }
        }
      } else {
        console.log(chalk.yellow('⚠️  No node groups found in the cluster'));
      }
    } catch (nodeGroupsError) {
      console.log(chalk.yellow(`⚠️  Could not list node groups: ${nodeGroupsError instanceof Error ? nodeGroupsError.message : String(nodeGroupsError)}`));
    }

    console.log('Verifying policy attachment...');
    try {
      const { stdout } = await executeCommand(`aws iam list-attached-role-policies --role-name "${roleName}"`, false);
      if (stdout.includes(lbcPolicyName)) {
        console.log(chalk.green(`✓ Policy '${lbcPolicyName}' successfully attached to role '${roleName}'`));
      } else {
        console.log(chalk.yellow(`⚠️  Policy attachment verification failed`));
      }
    } catch (verifyError) {
      console.log(chalk.yellow(`⚠️  Could not verify policy attachment: ${verifyError instanceof Error ? verifyError.message : String(verifyError)}`));
    }

    await this.restartLoadBalancerController();

    console.log(chalk.green('IAM permissions configured successfully!'));
  }

  private async createElasticIPs(region: string, bootnodeCount: number): Promise<string[]> {
    console.log(chalk.blue(`Creating Elastic IPs for ${bootnodeCount} L2 bootnode(s)...`));

    const allocationIds: string[] = [];

    for (let i = 0; i < bootnodeCount; i++) {
      const eipName = `bootnode-${i}-p2p`;

      try {
        const { stdout } = await executeCommand(`aws ec2 describe-addresses \
          --filters "Name=tag:Name,Values=${eipName}" \
          --query "Addresses[0].AllocationId" \
          --output text \
          --region "${region}"`);

        if (stdout.trim() !== 'None' && stdout.trim() !== 'null') {
          console.log(chalk.yellow(`Elastic IP '${eipName}' already exists with allocation ID: ${stdout.trim()}`));
          allocationIds[i] = stdout.trim();
        } else {
          throw new Error('EIP not found');
        }
      } catch (error) {
        console.log(`Creating Elastic IP for bootnode-${i}...`);
        const { stdout: allocationId } = await executeCommand(`aws ec2 allocate-address \
          --domain vpc \
          --tag-specifications "ResourceType=elastic-ip,Tags=[{Key=Name,Value=${eipName}},{Key=Purpose,Value=L2-Bootnode-P2P}]" \
          --query "AllocationId" \
          --output text \
          --region "${region}"`);

        allocationIds[i] = allocationId.trim();

        const { stdout: ipAddress } = await executeCommand(`aws ec2 describe-addresses \
          --allocation-ids "${allocationId.trim()}" \
          --query "Addresses[0].PublicIp" \
          --output text \
          --region "${region}"`);

        console.log(chalk.green(`Created Elastic IP for bootnode-${i}: ${ipAddress.trim()} (allocation: ${allocationId.trim()})`));
      }
    }

    console.log('');
    console.log(chalk.blue('Elastic IP Summary:'));
    console.log('===================');
    for (let i = 0; i < bootnodeCount; i++) {
      const { stdout: ipAddress } = await executeCommand(`aws ec2 describe-addresses \
        --allocation-ids "${allocationIds[i]}" \
        --query "Addresses[0].PublicIp" \
        --output text \
        --region "${region}"`);
      console.log(`  bootnode-${i}: ${ipAddress.trim()} (${allocationIds[i]})`);
    }
    console.log('');

    return allocationIds;
  }

  private getNestedValue(obj: any, path: string): any {
    return path.split('.').reduce((prev, curr) => prev && prev[curr], obj)
  }

  private safeSet(obj: any, pathString: string, value: any): boolean {
    if (typeof obj !== 'object' || obj === null) {
      console.warn(chalk.yellow(`Cannot set property on a non-object (path: ${pathString}). Target object is: ${String(obj)}`));
      return false;
    }
    const keys = pathString.split('.');
    let current = obj;
    for (let i = 0; i < keys.length - 1; i++) {
      const key = keys[i];
      if (current[key] === null || typeof current[key] !== 'object') {
        current[key] = {};
      }
      current = current[key];
    }
    current[keys[keys.length - 1]] = value;
    return true;
  }

  /**
   * Safely parse AWS CLI JSON output. When the CLI returns the literal strings
   * "None", "null" or an empty value, JSON.parse will throw. This helper
   * normalises those cases to null and suppresses parse errors so that the
   * caller can handle them gracefully.
   */
  private safeJsonParse(input: string): any | null {
    try {
      const trimmed = input?.trim();
      if (!trimmed || trimmed === 'None' || trimmed === 'null') {
        return null;
      }
      return JSON.parse(trimmed);
    } catch {
      return null;
    }
  }

  private async getSubnetForEip(allocationId: string, region: string, clusterName: string, bootnodeIndex?: number): Promise<string | null> {
    try {
      const { stdout: publicIp } = await executeCommand(`aws ec2 describe-addresses \
        --allocation-ids "${allocationId}" \
        --query "Addresses[0].PublicIp" \
        --output text \
        --region "${region}"`);

      if (!publicIp || publicIp.trim() === 'None') {
        console.log(chalk.yellow(`⚠️  Could not get public IP for allocation ${allocationId}`));
        return null;
      }

      const { stdout: clusterInfo } = await executeCommand(`aws eks describe-cluster \
        --name "${clusterName}" \
        --region "${region}" \
        --query "cluster.resourcesVpcConfig" \
        --output json`);

      const vpcConfig = this.safeJsonParse(clusterInfo);
      const subnetIds: string[] = (vpcConfig?.subnetIds ?? []) as string[];

      if (subnetIds.length === 0) {
        console.log(chalk.yellow('⚠️  Could not determine subnet IDs from cluster configuration'));
        return null;
      }

      // Get public subnets with their availability zones
      const publicSubnets: Array<{ subnetId: string, availabilityZone: string }> = [];

      for (const subnetId of subnetIds) {
        try {
          // 1) Check route table for IGW path
          const { stdout: routeTables } = await executeCommand(`aws ec2 describe-route-tables \
            --filters "Name=association.subnet-id,Values=${subnetId}" \
            --query "RouteTables[*].Routes[?DestinationCidrBlock=='0.0.0.0/0' && starts_with(GatewayId || '', 'igw-')]" \
            --output json \
            --region "${region}"`);
          const routes = this.safeJsonParse(routeTables) || [];

          // 2) Fetch subnet attributes (AZ, MapPublicIpOnLaunch, Tags)
          const { stdout: subnetJson } = await executeCommand(`aws ec2 describe-subnets \
            --subnet-ids "${subnetId}" \
            --output json \
            --region "${region}"`, false);
          const subnetObj = (this.safeJsonParse(subnetJson)?.Subnets ?? [])[0] || {};
          const az = (subnetObj.AvailabilityZone ?? '').trim();
          const mapPublic = subnetObj.MapPublicIpOnLaunch === true;
          const hasElbTag = (subnetObj.Tags ?? []).some((t: any) => t.Key === 'kubernetes.io/role/elb' && t.Value === '1');

          const routeHasIgw = Array.isArray(routes) && routes.length > 0 &&
            routes.some((rt: any[]) => rt && rt.length > 0);

          // Determine if this subnet qualifies as public
          if (routeHasIgw || mapPublic || hasElbTag) {
            publicSubnets.push({ subnetId, availabilityZone: az });
          }
        } catch (error) {
          console.log(chalk.yellow(`⚠️  Could not get route tables for subnet ${subnetId}: ${error instanceof Error ? error.message : String(error)}`));
        }
      }

      if (publicSubnets.length === 0) {
        console.log(chalk.yellow('⚠️  No public subnets found, using first available subnet'));
        return subnetIds[0] || null;
      }

      // Round-robin subnet allocation strategy for all bootnodes
      let selectedSubnet: string;

      if (bootnodeIndex !== undefined) {
        // Use round-robin to distribute bootnodes across different AZs
        const subnetIndex = bootnodeIndex % publicSubnets.length;
        selectedSubnet = publicSubnets[subnetIndex].subnetId;
        console.log(chalk.blue(`ℹ️  Bootnode-${bootnodeIndex}: Using subnet ${selectedSubnet} in AZ ${publicSubnets[subnetIndex].availabilityZone} (round-robin allocation)`));
      } else {
        // Fallback: use hash-based allocation if bootnodeIndex is not provided
        const hash = allocationId.split('').reduce((a, b) => {
          a = ((a << 5) - a) + b.charCodeAt(0);
          return a & a;
        }, 0);

        const subnetIndex = Math.abs(hash) % publicSubnets.length;
        selectedSubnet = publicSubnets[subnetIndex].subnetId;
        console.log(chalk.blue(`ℹ️  EIP ${allocationId}: Using subnet ${selectedSubnet} in AZ ${publicSubnets[subnetIndex].availabilityZone} (hash-based allocation)`));
      }

      return selectedSubnet;

    } catch (error) {
      console.log(chalk.yellow(`⚠️  Error finding subnet for EIP ${allocationId}: ${error instanceof Error ? error.message : String(error)}`));
      return null;
    }
  }

  private async configL2BootnodeP2p(doc: any, allocationIds: string[], index: number, region?: string, clusterName?: string) {

    if (!doc.service) doc.service = {};
    if (!doc.service.p2p) doc.service.p2p = {};

    const p2pCfg = doc.service.p2p;
    p2pCfg.enabled = true;

    if (!p2pCfg.annotations || typeof p2pCfg.annotations !== 'object') {
      p2pCfg.annotations = {};
    }
    const annotations: Record<string, string> = p2pCfg.annotations;

    annotations['service.beta.kubernetes.io/aws-load-balancer-type'] ||= 'nlb';
    annotations['service.beta.kubernetes.io/aws-load-balancer-scheme'] ||= 'internet-facing';
    annotations['service.beta.kubernetes.io/aws-load-balancer-nlb-target-type'] ||= 'ip';
    annotations['service.beta.kubernetes.io/aws-load-balancer-cross-zone-load-balancing-enabled'] = 'true';
    const lbNamePrefix = clusterName ? `${clusterName}-` : '';
    annotations['service.beta.kubernetes.io/aws-load-balancer-name'] = `${lbNamePrefix}b-${index}`;

    let allocationId = null;
    if (allocationIds.length > index) {
      allocationId = allocationIds[index];
    }
    if (allocationId) {
      annotations['service.beta.kubernetes.io/aws-load-balancer-eip-allocations'] = allocationId;
      if (region && clusterName) {
        const subnetId = await this.getSubnetForEip(allocationId, region, clusterName, index);
        if (subnetId) {
          annotations['service.beta.kubernetes.io/aws-load-balancer-subnets'] = subnetId;
          console.log(chalk.green(`✓ Added subnet annotation: ${subnetId} for EIP ${allocationId}`));
        }
      }
    }
  }

  private async updateProductionFilesWithEips(allocationIds: string[], valuesDir: string, bootnodeCount: number, region: string, clusterName: string): Promise<void> {
    console.log(chalk.blue('Updating production YAML files...'));

    for (let i = 0; i < bootnodeCount; i++) {
      const prodFile = path.join(valuesDir, `l2-bootnode-production-${i}.yaml`);

      if (fs.existsSync(prodFile)) {
        console.log(`Updating ${prodFile}...`);

        let content = fs.readFileSync(prodFile, 'utf8');

        const yamlData = yaml.load(content) as any;

        await this.configL2BootnodeP2p(yamlData, allocationIds, i, region, clusterName);

        content = yaml.dump(yamlData, YAML_DUMP_OPTIONS);
        fs.writeFileSync(prodFile, content);

        //console.log(chalk.green(`Updated ${prodFile} with allocation ID: ${allocationIds[i]}`));
      } else {
        console.log(chalk.yellow(`Production file ${prodFile} not found, skipping...`));
      }
    }
  }

  private async verifyAwsSetup(accountId: string, region: string, bootnodeCount: number): Promise<boolean> {
    console.log(chalk.blue('Verifying setup...'));

    let allChecksPass = true;

    try {
      const { stdout } = await executeCommand(`kubectl get deployment aws-load-balancer-controller -n kube-system -o jsonpath='{.status.conditions[?(@.type=="Available")].status}'`, false);
      if (stdout.trim() === 'True') {
        console.log(chalk.green('✓ AWS Load Balancer Controller is running'));
      } else {
        console.log(chalk.red('✗ AWS Load Balancer Controller is not ready'));
        allChecksPass = false;
      }
    } catch (error) {
      console.log(chalk.red('✗ AWS Load Balancer Controller not found'));
      allChecksPass = false;
    }

    try {
      await executeCommand(`aws iam get-policy --policy-arn "arn:aws:iam::${accountId}:policy/EKSElasticIPManagement"`, false);
      console.log(chalk.green('✓ IAM policy exists'));
    } catch (error) {
      console.log(chalk.red('✗ IAM policy not found'));
      allChecksPass = false;
    }

    for (let i = 0; i < bootnodeCount; i++) {
      const eipName = `bootnode-${i}-p2p`;
      try {
        const { stdout } = await executeCommand(`aws ec2 describe-addresses --filters "Name=tag:Name,Values=${eipName}" --region "${region}"`);
        if (stdout.includes('AllocationId')) {
          console.log(chalk.green(`✓ Elastic IP for bootnode-${i} exists`));
        } else {
          console.log(chalk.red(`✗ Elastic IP for bootnode-${i} not found`));
          allChecksPass = false;
        }
      } catch (error) {
        console.log(chalk.red(`✗ Elastic IP for bootnode-${i} not found`));
        allChecksPass = false;
      }
    }

    console.log('');
    if (allChecksPass) {
      console.log(chalk.green('✅ Setup verification complete - All checks passed!'));
    } else {
      console.log(chalk.yellow('⚠️  Setup verification complete - Some checks failed'));
    }

    return allChecksPass;
  }
} 