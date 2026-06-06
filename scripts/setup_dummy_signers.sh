#!/usr/bin/env bash
#
# setup_dummy_signers.sh
#
# Creates ECS Express Mode IAM roles, KMS keys & aliases, grants,
# and ECS Express service for ${NETWORK_ALIAS:-devnet00}-dummy-signer-{SUFFIX}.
#
# Usage:
#   NETWORK_ALIAS=devnet00 \                  # prefix for service names and KMS alias
#   DOGECOIN_NETWORK=testnet \               # network to use for the signer
#   AWS_ACCOUNT_ID=012345678901 \             # your AWS account
#   AWS_REGION=us-east-1 \                     # region for ECR, KMS, and ECS
#   ECS_CLUSTER=default \                      # ECS cluster for the Express Mode service
#   IMAGE_URI=dogeos69/dummy-signer:newda \
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

# Internal legacy signer IDs used by existing ECS/KMS resource names.
# TEE_SIGNER_ID is kept for CLI compatibility and may contain a space-separated list.
SIGNER_IDS="${DUMMY_SIGNER_IDS:-${TEE_SIGNER_ID:-00}}"

# AWS account and region
AWS_ACCOUNT_ID="${AWS_ACCOUNT_ID:?Need to set AWS_ACCOUNT_ID}"
AWS_REGION="${AWS_REGION:-us-east-1}"

# Docker image to deploy (ECR, Docker Hub, or another registry)
IMAGE_URI="${IMAGE_URI:?Need to set IMAGE_URI}"

# Initial environment vars for the container
DUMMY_SIGNER_TSO_URL="${TSO_URL:?Need to set TSO_URL}"

# App port, health path, and optional ECS Express Mode sizing
APP_PORT="${APP_PORT:-8080}"
HEALTH_PATH="${HEALTH_PATH:-/health}"
ECS_CLUSTER="${ECS_CLUSTER:-default}"
ECS_CPU="${ECS_CPU:-}"
ECS_MEMORY="${ECS_MEMORY:-}"
ECS_MIN_TASKS="${ECS_MIN_TASKS:-1}"
ECS_MAX_TASKS="${ECS_MAX_TASKS:-1}"
ECS_DEPLOYMENT_MAX_PERCENT="${ECS_DEPLOYMENT_MAX_PERCENT:-100}"
ECS_DEPLOYMENT_MIN_HEALTHY_PERCENT="${ECS_DEPLOYMENT_MIN_HEALTHY_PERCENT:-0}"
ECS_AVAILABILITY_ZONE_REBALANCING="${ECS_AVAILABILITY_ZONE_REBALANCING:-DISABLED}"
# Optional Rust logging settings
RUST_LOG="${RUST_LOG:-info}"
RUST_BACKTRACE="${RUST_BACKTRACE:-1}"
### ────────────────────────────────────────────────────── ###

if (( ECS_MAX_TASKS < ECS_MIN_TASKS )); then
  ECS_MAX_TASKS="$ECS_MIN_TASKS"
fi

if ! aws ecs create-express-gateway-service help &>/dev/null; then
  echo "AWS CLI does not support ECS Express Mode commands. Please upgrade AWS CLI v2."
  exit 1
fi

configure_ecs_deployment_bounds() {
  local SERVICE_NAME="$1"

  aws ecs update-service \
    --cluster "$ECS_CLUSTER" \
    --region "$AWS_REGION" \
    --service "$SERVICE_NAME" \
    --availability-zone-rebalancing "$ECS_AVAILABILITY_ZONE_REBALANCING" \
    --deployment-configuration "{\"maximumPercent\":${ECS_DEPLOYMENT_MAX_PERCENT},\"minimumHealthyPercent\":${ECS_DEPLOYMENT_MIN_HEALTHY_PERCENT},\"deploymentCircuitBreaker\":{\"enable\":true,\"rollback\":true}}" \
    --no-cli-pager \
    >/dev/null
}

update_assume_role_policy() {
  local ROLE_NAME="$1"
  local POLICY_FILE="$2"

  aws iam update-assume-role-policy \
    --role-name "$ROLE_NAME" \
    --policy-document file://"$POLICY_FILE" \
    --no-cli-pager
}

#  — ECS Express Mode shared roles — 
ECS_EXECUTION_ROLE_NAME="ecs-dummy-signer-task-execution-role"
ECS_INFRASTRUCTURE_ROLE_NAME="ecs-dummy-signer-express-infrastructure-role"
ECS_TASK_ASSUME_ROLE_POLICY_FILE="/tmp/ecs-task-assume-role-policy.json"
ECS_INFRASTRUCTURE_ASSUME_ROLE_POLICY_FILE="/tmp/ecs-infrastructure-assume-role-policy.json"

cat > "$ECS_TASK_ASSUME_ROLE_POLICY_FILE" <<EOF
{
  "Version":"2012-10-17",
  "Statement":[
    {
      "Effect":"Allow",
      "Principal":{"Service":"ecs-tasks.amazonaws.com"},
      "Action":"sts:AssumeRole"
    }
  ]
}
EOF

cat > "$ECS_INFRASTRUCTURE_ASSUME_ROLE_POLICY_FILE" <<EOF
{
  "Version":"2012-10-17",
  "Statement":[
    {
      "Sid":"AllowAccessInfrastructureForECSExpressServices",
      "Effect":"Allow",
      "Principal":{"Service":"ecs.amazonaws.com"},
      "Action":"sts:AssumeRole"
    }
  ]
}
EOF

if ! aws iam get-role --role-name "$ECS_EXECUTION_ROLE_NAME" &>/dev/null; then
  aws iam create-role \
    --role-name "$ECS_EXECUTION_ROLE_NAME" \
    --assume-role-policy-document file://"$ECS_TASK_ASSUME_ROLE_POLICY_FILE"
  echo " • Created ECS task execution role $ECS_EXECUTION_ROLE_NAME"
else
  echo " • ECS task execution role already exists: $ECS_EXECUTION_ROLE_NAME"
  update_assume_role_policy "$ECS_EXECUTION_ROLE_NAME" "$ECS_TASK_ASSUME_ROLE_POLICY_FILE"
  echo " • Updated trust policy for $ECS_EXECUTION_ROLE_NAME"
fi

aws iam attach-role-policy \
  --role-name "$ECS_EXECUTION_ROLE_NAME" \
  --policy-arn arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy \
  --no-cli-pager

if ! aws iam get-role --role-name "$ECS_INFRASTRUCTURE_ROLE_NAME" &>/dev/null; then
  aws iam create-role \
    --role-name "$ECS_INFRASTRUCTURE_ROLE_NAME" \
    --assume-role-policy-document file://"$ECS_INFRASTRUCTURE_ASSUME_ROLE_POLICY_FILE"
  echo " • Created ECS Express infrastructure role $ECS_INFRASTRUCTURE_ROLE_NAME"
else
  echo " • ECS Express infrastructure role already exists: $ECS_INFRASTRUCTURE_ROLE_NAME"
  update_assume_role_policy "$ECS_INFRASTRUCTURE_ROLE_NAME" "$ECS_INFRASTRUCTURE_ASSUME_ROLE_POLICY_FILE"
  echo " • Updated trust policy for $ECS_INFRASTRUCTURE_ROLE_NAME"
fi

aws iam attach-role-policy \
  --role-name "$ECS_INFRASTRUCTURE_ROLE_NAME" \
  --policy-arn arn:aws:iam::aws:policy/service-role/AmazonECSInfrastructureRoleforExpressGatewayServices \
  --no-cli-pager

ECS_EXECUTION_ROLE_ARN="arn:aws:iam::${AWS_ACCOUNT_ID}:role/${ECS_EXECUTION_ROLE_NAME}"
ECS_INFRASTRUCTURE_ROLE_ARN="arn:aws:iam::${AWS_ACCOUNT_ID}:role/${ECS_INFRASTRUCTURE_ROLE_NAME}"
echo " • ECS task execution role ARN is $ECS_EXECUTION_ROLE_ARN"
echo " • ECS Express infrastructure role ARN is $ECS_INFRASTRUCTURE_ROLE_ARN"

if ! aws ecs describe-clusters \
  --clusters "$ECS_CLUSTER" \
  --region "$AWS_REGION" \
  --query "clusters[?status=='ACTIVE'].clusterName" \
  --output text | grep -q "^${ECS_CLUSTER}$"; then
  aws ecs create-cluster \
    --cluster-name "$ECS_CLUSTER" \
    --region "$AWS_REGION" \
    --no-cli-pager >/dev/null
  echo " • Created ECS cluster $ECS_CLUSTER"
else
  echo " • ECS cluster already exists: $ECS_CLUSTER"
fi

#############################################
# Step A: Per-service IAM roles & policies  #
#############################################

for SIGNER_ID in $SIGNER_IDS; do
  SERVICE="${NETWORK_ALIAS}-dummy-signer-${SIGNER_ID}"
  ROLE_NAME="${SERVICE}-role"
  ROLE_ARN="arn:aws:iam::${AWS_ACCOUNT_ID}:role/${ROLE_NAME}"
  SERVICE_TASK_ASSUME_ROLE_POLICY_FILE="/tmp/${SERVICE}-task-assume-role-policy.json"

  echo "🔧 [${SERVICE}] Ensuring IAM role exists..."

  cat > "$SERVICE_TASK_ASSUME_ROLE_POLICY_FILE" <<EOF
{
  "Version":"2012-10-17",
  "Statement":[
    {
      "Effect":"Allow",
      "Principal":{"Service":"ecs-tasks.amazonaws.com"},
      "Action":"sts:AssumeRole"
    }
  ]
}
EOF

  # 1. Create the IAM role if missing
  if ! aws iam get-role --role-name "${ROLE_NAME}" &>/dev/null; then
    aws iam create-role \
      --role-name "${ROLE_NAME}" \
      --assume-role-policy-document file://"$SERVICE_TASK_ASSUME_ROLE_POLICY_FILE"
    echo "  • Created role ${ROLE_NAME}"
  else
    echo "  • Role already exists: ${ROLE_NAME}"
    update_assume_role_policy "$ROLE_NAME" "$SERVICE_TASK_ASSUME_ROLE_POLICY_FILE"
    echo "  • Updated trust policy for ${ROLE_NAME}"
  fi

  echo "  • ${ROLE_NAME} is ready for ECS tasks"
done


#############################################
# Step B: Create per-service KMS keys & grants #
#############################################

for SIGNER_ID in $SIGNER_IDS; do
  SERVICE="${NETWORK_ALIAS}-dummy-signer-${SIGNER_ID}"
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
# Step C: Create or update ECS Express services #
#############################################

for SIGNER_ID in $SIGNER_IDS; do
  SERVICE="${NETWORK_ALIAS}-dummy-signer-${SIGNER_ID}"
  ROLE_ARN="arn:aws:iam::${AWS_ACCOUNT_ID}:role/${SERVICE}-role"
  ALIAS_NAME="alias/${SERVICE}-key"

  echo "🚀 [$SERVICE] Creating/updating ECS Express Mode service…"

  SERVICE_ARN=$(aws ecs list-services \
    --cluster "$ECS_CLUSTER" \
    --region "$AWS_REGION" \
    --query "serviceArns[?ends_with(@, '/${SERVICE}')]" \
    --output text || true)

  PRIMARY_CONTAINER_FILE="/tmp/${SERVICE}-primary-container.json"
  SCALING_TARGET_FILE="/tmp/${SERVICE}-scaling-target.json"

  cat > "$PRIMARY_CONTAINER_FILE" <<EOF
{
  "image": "${IMAGE_URI}",
  "containerPort": ${APP_PORT},
  "command": [
    "--port",
    "${APP_PORT}",
    "--tso-url",
    "${DUMMY_SIGNER_TSO_URL}",
    "--aws-region",
    "${AWS_REGION}",
    "--network",
    "${DOGECOIN_NETWORK}",
    "--kms-key-id",
    "${ALIAS_NAME}"
  ],
  "environment": [
    { "name": "DUMMY_SIGNER_TSO_URL", "value": "${DUMMY_SIGNER_TSO_URL}" },
    { "name": "DUMMY_SIGNER_KMS_KEY_ID", "value": "${ALIAS_NAME}" },
    { "name": "DUMMY_SIGNER_AWS_REGION", "value": "${AWS_REGION}" },
    { "name": "DUMMY_SIGNER_NETWORK", "value": "${DOGECOIN_NETWORK}" },
    { "name": "RUST_LOG", "value": "${RUST_LOG}" },
    { "name": "RUST_BACKTRACE", "value": "${RUST_BACKTRACE}" }
  ]
}
EOF

  cat > "$SCALING_TARGET_FILE" <<EOF
{
  "minTaskCount": ${ECS_MIN_TASKS},
  "maxTaskCount": ${ECS_MAX_TASKS}
}
EOF

  CPU_MEMORY_ARGS=()
  if [ -n "$ECS_CPU" ]; then
    CPU_MEMORY_ARGS+=(--cpu "$ECS_CPU")
  fi

  if [ -n "$ECS_MEMORY" ]; then
    CPU_MEMORY_ARGS+=(--memory "$ECS_MEMORY")
  fi

  run_ecs_create_express_gateway_service() {
    if [ ${#CPU_MEMORY_ARGS[@]} -gt 0 ]; then
      aws ecs create-express-gateway-service \
        --region "$AWS_REGION" \
        --cluster "$ECS_CLUSTER" \
        --service-name "$SERVICE" \
        --execution-role-arn "$ECS_EXECUTION_ROLE_ARN" \
        --infrastructure-role-arn "$ECS_INFRASTRUCTURE_ROLE_ARN" \
        --task-role-arn "$ROLE_ARN" \
        --primary-container file://"$PRIMARY_CONTAINER_FILE" \
        "${CPU_MEMORY_ARGS[@]}" \
        --health-check-path "$HEALTH_PATH" \
        --scaling-target file://"$SCALING_TARGET_FILE"
    else
      aws ecs create-express-gateway-service \
        --region "$AWS_REGION" \
        --cluster "$ECS_CLUSTER" \
        --service-name "$SERVICE" \
        --execution-role-arn "$ECS_EXECUTION_ROLE_ARN" \
        --infrastructure-role-arn "$ECS_INFRASTRUCTURE_ROLE_ARN" \
        --task-role-arn "$ROLE_ARN" \
        --primary-container file://"$PRIMARY_CONTAINER_FILE" \
        --health-check-path "$HEALTH_PATH" \
        --scaling-target file://"$SCALING_TARGET_FILE"
    fi
  }

  run_ecs_update_express_gateway_service() {
    if [ ${#CPU_MEMORY_ARGS[@]} -gt 0 ]; then
      aws ecs update-express-gateway-service \
        --region "$AWS_REGION" \
        --service-arn "$SERVICE_ARN" \
        --execution-role-arn "$ECS_EXECUTION_ROLE_ARN" \
        --task-role-arn "$ROLE_ARN" \
        --primary-container file://"$PRIMARY_CONTAINER_FILE" \
        "${CPU_MEMORY_ARGS[@]}" \
        --health-check-path "$HEALTH_PATH" \
        --scaling-target file://"$SCALING_TARGET_FILE"
    else
      aws ecs update-express-gateway-service \
        --region "$AWS_REGION" \
        --service-arn "$SERVICE_ARN" \
        --execution-role-arn "$ECS_EXECUTION_ROLE_ARN" \
        --task-role-arn "$ROLE_ARN" \
        --primary-container file://"$PRIMARY_CONTAINER_FILE" \
        --health-check-path "$HEALTH_PATH" \
        --scaling-target file://"$SCALING_TARGET_FILE"
    fi
  }

  if [ -z "$SERVICE_ARN" ]; then
    run_ecs_create_express_gateway_service

    configure_ecs_deployment_bounds "$SERVICE"
    echo "  • Created $SERVICE"
  else
    configure_ecs_deployment_bounds "$SERVICE"

    run_ecs_update_express_gateway_service

    configure_ecs_deployment_bounds "$SERVICE"
    echo "  • Updated $SERVICE"
  fi
done

echo "🎉 Dummy attestation signer services are configured and deployed."
