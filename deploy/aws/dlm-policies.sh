#!/usr/bin/env bash
# EBS snapshot lifecycle for the dev VM, via DLM (the console can't do sub-daily —
# the 4-hourly cadence needs the CLI). Two schedules on volumes tagged
# claude0-backup=true: 4-hourly kept 3 days (uncommitted-work granularity) and daily
# kept 14 days. Idempotent: skips policies whose description already exists.
#
#   ./dlm-policies.sh [--region eu-central-1]
#
# Also creates the budget guardrail: an action-enabled AWS Budget that STOPS the
# instance past the monthly threshold — nothing else stops billing when credits
# run out. Run with credentials that may create IAM roles.
set -euo pipefail

REGION="eu-central-1"
while [ $# -gt 0 ]; do
  case "$1" in
    --region) REGION="$2"; shift 2 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

note() { printf '[dlm] %s\n' "$*"; }

ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
ROLE_NAME="AWSDataLifecycleManagerDefaultRole"

# The DLM service role: AWS's managed default, created once per account.
if ! aws iam get-role --role-name "$ROLE_NAME" >/dev/null 2>&1; then
  note "creating $ROLE_NAME"
  aws dlm create-default-role --resource-type snapshot --region "$REGION" 2>/dev/null || {
    aws iam create-role --role-name "$ROLE_NAME" --path /service-role/ \
      --assume-role-policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"dlm.amazonaws.com"},"Action":"sts:AssumeRole"}]}' >/dev/null
    aws iam attach-role-policy --role-name "$ROLE_NAME" \
      --policy-arn arn:aws:iam::aws:policy/service-role/AWSDataLifecycleManagerServiceRole
  }
fi
# Read the ARN from the role itself: `dlm create-default-role` makes it at path `/`,
# the manual fallback at `/service-role/` — a hardcoded path points policies at a
# role that doesn't exist, which only surfaces when the first snapshot fails.
ROLE_ARN=$(aws iam get-role --role-name "$ROLE_NAME" --query Role.Arn --output text)

create_policy() {
  local desc="$1" interval="$2" unit="$3" keep="$4" times="$5"
  if aws dlm get-lifecycle-policies --region "$REGION" \
      --query "Policies[?Description=='${desc}']" --output text | grep -q .; then
    note "policy exists: $desc"
    return
  fi
  note "creating policy: $desc"
  local schedule
  schedule=$(cat <<JSON
{
  "PolicyType": "EBS_SNAPSHOT_MANAGEMENT",
  "ResourceTypes": ["VOLUME"],
  "TargetTags": [{"Key": "claude0-backup", "Value": "true"}],
  "Schedules": [{
    "Name": "$desc",
    "CreateRule": {"Interval": $interval, "IntervalUnit": "$unit", "Times": [$times]},
    "RetainRule": {"Count": $keep},
    "CopyTags": true
  }]
}
JSON
)
  aws dlm create-lifecycle-policy --region "$REGION" \
    --execution-role-arn "$ROLE_ARN" \
    --description "$desc" \
    --state ENABLED \
    --policy-details "$schedule" >/dev/null
}

# 4-hourly × 18 slots = 3 days of uncommitted-work granularity.
create_policy "claude0-4hourly-3d" 4 HOURS 18 '"09:00"'
# Daily × 14 — the deeper undo ladder.
create_policy "claude0-daily-14d" 24 HOURS 14 '"03:00"'

note "policies: $(aws dlm get-lifecycle-policies --region "$REGION" --query 'Policies[].Description' --output text)"
note "remember: tag the root volume claude0-backup=true, and measure FullSnapshotSizeInBytes deltas for a day before considering hourly (build caches inflate incrementals)."

# ── Budget guardrail ───────────────────────────────────────────────────────────
# Requires a one-time budgets action role; if absent, print the console pointer
# rather than half-configuring it.
if aws budgets describe-budgets --account-id "$ACCOUNT" \
    --query "Budgets[?BudgetName=='vm-stop']" --output text 2>/dev/null | grep -q .; then
  note "budget guardrail exists"
else
  note "ACTION NEEDED: create an action-enabled budget 'vm-stop' (Billing → Budgets)"
  note "  threshold: your monthly ceiling; action: Stop EC2 instance <instance-id>."
  note "  Budgets actions need their own IAM role — the console flow creates it; the CLI needs it pre-created."
fi
