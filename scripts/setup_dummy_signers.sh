#!/usr/bin/env bash
#
# setup_dummy_signers.sh
#
# Creates per-service App Runner IAM roles, KMS keys & aliases, grants, and
# App Runner services for ${NETWORK_ALIAS:-devnet00}-dummy-signer-{SUFFIXES}.
#
# Usage:
#   NETWORK_ALIAS=devnet00 \                  # prefix for service names and KMS alias
#   DOGECOIN_NETWORK=testnet \               # network to use for the signer
#   SUFFIXES="00 01 02" \                     # list of service suffixes
#   AWS_ACCOUNT_ID=012345678901 \             # your AWS account
#   AWS_REGION=us-east-1 \                     # region for ECR, KMS, and App Runner
#   IMAGE_URI=012345678901.dkr.ecr.us-east-1.amazonaws.com/dogeos-dummy-signer:latest \
#   TSO_URL=https://tso.example.com \
#   ./setup_dummy_signers.sh
#

set -euo pipefail
# Disable AWS CLI pager so you never get stuck in 'less'
export AWS_PAGER=""  
export AWS_NO_PAGER=1

### ──────────────── Configuration via ENV ──────────────── ###
# Logical prefix for service names and KMS alias
NETWORK_ALIAS="${NETWORK_ALIAS:-devnet00}"

# Network to use for the signer
DOGECOIN_NETWORK="${DOGECOIN_NETWORK:-testnet}"

# Suffixes to provision (override e.g. "00 01 02")
SUFFIXES=( ${SUFFIXES:-00 01 02} )

# AWS account and region
AWS_ACCOUNT_ID="${AWS_ACCOUNT_ID:?Need to set AWS_ACCOUNT_ID}"
AWS_REGION="${AWS_REGION:-us-east-1}"

# Docker image to deploy (must already exist in ECR)
IMAGE_URI="${IMAGE_URI:?Need to set IMAGE_URI}"

# Initial environment vars for the container
DUMMY_SIGNER_TSO_URL="${TSO_URL:?Need to set TSO_URL}"

# App port and health path
APP_PORT="${APP_PORT:-8080}"
HEALTH_PATH="${HEALTH_PATH:-/health}"
# Optional Rust logging settings
RUST_LOG="${RUST_LOG:-info}"
RUST_BACKTRACE="${RUST_BACKTRACE:-1}"
### ────────────────────────────────────────────────────── ###

#  — ECR pull role — 
ECR_ROLE_NAME="apprunner-dummy-signer-ecr-access-role"

# 1. Create the role if missing
if ! aws iam get-role --role-name "$ECR_ROLE_NAME" &>/dev/null; then
  aws iam create-role \
    --role-name "$ECR_ROLE_NAME" \
    --assume-role-policy-document '{
      "Version":"2012-10-17",
      "Statement":[
        {
          "Effect":"Allow",
          "Principal":{"Service":"build.apprunner.amazonaws.com"},
          "Action":"sts:AssumeRole"
        }
      ]
    }'
  echo " • Created ECR-access build role $ECR_ROLE_NAME"
else
  echo " • ECR-access build role already exists: $ECR_ROLE_NAME"
fi

# 2. Attach ECR read-only
aws iam attach-role-policy \
  --role-name "$ECR_ROLE_NAME" \
  --policy-arn arn:aws:iam::aws:policy/AmazonEC2ContainerRegistryReadOnly \
  --no-cli-pager

ECR_ROLE_ARN="arn:aws:iam::${AWS_ACCOUNT_ID}:role/${ECR_ROLE_NAME}"
echo " • ECR-access role ARN is $ECR_ROLE_ARN"

#############################################
# Step A: Per-service IAM roles & policies  #
#############################################

for SUFFIX in "${SUFFIXES[@]}"; do
  SERVICE="${NETWORK_ALIAS}-dummy-signer-${SUFFIX}"
  ROLE_NAME="${SERVICE}-role"
  ROLE_ARN="arn:aws:iam::${AWS_ACCOUNT_ID}:role/${ROLE_NAME}"

  echo "🔧 [${SERVICE}] Ensuring IAM role exists..."

  # 1. Create the IAM role if missing
  if ! aws iam get-role --role-name "${ROLE_NAME}" &>/dev/null; then
    aws iam create-role \
      --role-name "${ROLE_NAME}" \
      --assume-role-policy-document '{
        "Version":"2012-10-17",
        "Statement":[
          {
            "Effect":"Allow",
            "Principal":{"Service":"tasks.apprunner.amazonaws.com"},
            "Action":"sts:AssumeRole"
          }
        ]
      }'
    echo "  • Created role ${ROLE_NAME}"
  else
    echo "  • Role already exists: ${ROLE_NAME}"
  fi

  # 2. Attach managed policies for ECR pull & CloudWatch Logs
  aws iam attach-role-policy \
    --role-name "${ROLE_NAME}" \
    --policy-arn arn:aws:iam::aws:policy/AmazonEC2ContainerRegistryReadOnly \
    --no-cli-pager || true

  aws iam attach-role-policy \
    --role-name "${ROLE_NAME}" \
    --policy-arn arn:aws:iam::aws:policy/CloudWatchLogsFullAccess \
    --no-cli-pager || true

  echo "  • Attached ECR & CloudWatch policies to ${ROLE_NAME}"
done


#############################################
# Step B: Create per-service KMS keys & grants #
#############################################

for SUFFIX in "${SUFFIXES[@]}"; do
  SERVICE="${NETWORK_ALIAS}-dummy-signer-${SUFFIX}"
  ROLE_NAME="${SERVICE}-role"
  ROLE_ARN="arn:aws:iam::${AWS_ACCOUNT_ID}:role/${ROLE_NAME}"
  ALIAS_NAME="alias/${SERVICE}-key"

  echo "🔑 [${SERVICE}] Ensuring KMS key & alias exist…"

  # 1. Check if the alias already exists
  EXISTING=$(aws kms list-aliases \
    --region "${AWS_REGION}" \
    --query "Aliases[?AliasName=='${ALIAS_NAME}'].TargetKeyId" \
    --output text || true)

  if [ -n "$EXISTING" ]; then
    # alias exists → reuse KeyId
    KEY_ID="$EXISTING"
    echo "  • Alias ${ALIAS_NAME} already exists (KeyId=${KEY_ID})"
    
    # Check if key is enabled
    KEY_STATE=$(aws kms describe-key \
      --key-id "${KEY_ID}" \
      --region "${AWS_REGION}" \
      --query "KeyMetadata.KeyState" \
      --output text)
    
    if [ "$KEY_STATE" = "Disabled" ]; then
      echo "  • Key is disabled, enabling it..."
      aws kms enable-key --key-id "${KEY_ID}" --region "${AWS_REGION}"
      echo "  • Key ${KEY_ID} enabled"
    elif [ "$KEY_STATE" = "Enabled" ]; then
      echo "  • Key ${KEY_ID} is already enabled"
    else
      echo "  • Warning: Key ${KEY_ID} state is ${KEY_STATE}"
    fi
  else
    # alias missing → create a new key + alias
    KEY_ID=$(aws kms create-key \
      --description "KMS key for ${SERVICE}" \
      --key-usage SIGN_VERIFY \
      --key-spec ECC_SECG_P256K1 \
      --query KeyMetadata.KeyId \
      --output text)

    aws kms create-alias \
      --alias-name "${ALIAS_NAME}" \
      --target-key-id "${KEY_ID}"

    echo "  • Created key ${KEY_ID} + alias ${ALIAS_NAME}"
  fi

  # 2. Inline policy scoped to this key (overwrites any prior policy)
  cat > /tmp/${SERVICE}-kms-policy.json <<EOF
{
  "Version":"2012-10-17",
  "Statement":[
    {
      "Sid":"AllowSignAndGetPublicKey",
      "Effect":"Allow",
      "Action":[ "kms:Sign", "kms:GetPublicKey" ],
      "Resource":"arn:aws:kms:${AWS_REGION}:${AWS_ACCOUNT_ID}:key/${KEY_ID}"
    }
  ]
}
EOF

  aws iam put-role-policy \
    --role-name "${ROLE_NAME}" \
    --policy-name "KmsPolicy-${SERVICE}" \
    --policy-document file:///tmp/${SERVICE}-kms-policy.json

  # 3. (Optional) Create a grant, but ignore "already exists" errors
  aws kms create-grant \
    --key-id "${KEY_ID}" \
    --grantee-principal "${ROLE_ARN}" \
    --operations Sign GetPublicKey \
    --region "${AWS_REGION}" \
    2>/dev/null || true

  echo "  • ${SERVICE} role scoped to key ${KEY_ID}"
done

#############################################
# Step C: Create or update App Runner services #
#############################################

for SUFFIX in "${SUFFIXES[@]}"; do
  SERVICE="${NETWORK_ALIAS}-dummy-signer-${SUFFIX}"
  ROLE_ARN="arn:aws:iam::${AWS_ACCOUNT_ID}:role/${SERVICE}-role"
  ALIAS_NAME="alias/${SERVICE}-key"

  echo "🚀 [$SERVICE] Creating/updating App Runner…"

  SERVICE_ARN=$(aws apprunner list-services \
    --region "$AWS_REGION" \
    --query "ServiceSummaryList[?ServiceName=='$SERVICE'].ServiceArn" \
    --output text)

  # Write the JSON for source-configuration
  SRC_CFG_FILE="/tmp/${SERVICE}-source-config.json"
  cat > "$SRC_CFG_FILE" <<EOF
{
  "ImageRepository": {
    "ImageIdentifier": "${IMAGE_URI}",
    "ImageRepositoryType": "ECR",
    "ImageConfiguration": {
      "Port": "${APP_PORT}",
      "RuntimeEnvironmentVariables": {
        "DUMMY_SIGNER_TSO_URL": "${DUMMY_SIGNER_TSO_URL}",
        "DUMMY_SIGNER_KMS_KEY_ID": "${ALIAS_NAME}",
        "DUMMY_SIGNER_AWS_REGION": "${AWS_REGION}",
        "DUMMY_SIGNER_NETWORK": "${DOGECOIN_NETWORK}",
        "RUST_LOG": "${RUST_LOG}",
        "RUST_BACKTRACE": "${RUST_BACKTRACE}"
      }
    }
  },
  "AuthenticationConfiguration": {
    "AccessRoleArn": "${ECR_ROLE_ARN}"
  },
  "AutoDeploymentsEnabled": true
}
EOF

  if [ -z "$SERVICE_ARN" ]; then
	aws apprunner create-service \
	--region "$AWS_REGION" \
	--service-name "$SERVICE" \
	--source-configuration file://"/tmp/${SERVICE}-source-config.json" \
	--instance-configuration InstanceRoleArn="$ROLE_ARN" \
	--health-check-configuration Protocol=HTTP,Path="$HEALTH_PATH",Interval=10,Timeout=5,HealthyThreshold=1,UnhealthyThreshold=3

    echo "  • Created $SERVICE"
  else
	aws apprunner update-service \
	--region "$AWS_REGION" \
	--service-arn "$SERVICE_ARN" \
	--source-configuration file://"/tmp/${SERVICE}-source-config.json" \
	--instance-configuration InstanceRoleArn="$ROLE_ARN"

    echo "  • Updated $SERVICE"
  fi
done

echo "🎉 All services (${SUFFIXES[*]}) are configured and deployed."