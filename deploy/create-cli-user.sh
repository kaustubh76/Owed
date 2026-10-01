#!/usr/bin/env bash
#
# Create the least-privilege IAM user that Owed's Phase 1 smoke test needs, and an access
# key for it.
#
# Run this in **AWS CloudShell** — the `>_` icon in the AWS console's top bar. CloudShell is
# already authenticated as whoever is signed into the console, which dissolves the
# chicken-and-egg problem: creating your first access key otherwise needs credentials you do
# not have yet.
#
#   console → CloudShell → paste this whole file → Enter
#
# Self-contained on purpose. CloudShell has no checkout, so the policy is inline rather than
# read from `iam-policy-phase1.json` beside it. If you change one, change both.
#
# It prints a secret access key once, which is unavoidable — AWS shows it once too. Keep it
# out of chat logs and screenshots, and delete the key when the project is done (the
# teardown commands are printed at the end).

set -euo pipefail

ACCOUNT="240250534690"
REGION="us-east-1"
USER_NAME="owed-cli"
POLICY_NAME="owed-phase1"
POLICY_ARN="arn:aws:iam::${ACCOUNT}:policy/${POLICY_NAME}"

# Scoped to this project's tables and nothing else: no EC2, no Bedrock, no IAM. Those get
# their own policies when the phases that need them arrive, rather than being granted now
# against a future need.
#
# Note what is NOT here: `dynamodb:TransactWriteItems`. It is not an IAM action — DynamoDB's
# transactional APIs have none of their own, and permission comes from the component
# operations, so a `Put` inside a `TransactWriteItems` needs `dynamodb:PutItem`. The IAM
# console rejects the string outright. The SDK command being called `TransactWriteCommand`
# makes a matching permission the natural thing to expect; it does not exist.
POLICY_DOCUMENT=$(
	cat <<'JSON'
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "LedgerTableOnly",
      "Effect": "Allow",
      "Action": [
        "dynamodb:CreateTable",
        "dynamodb:DescribeTable",
        "dynamodb:DeleteTable",
        "dynamodb:Query",
        "dynamodb:Scan",
        "dynamodb:GetItem",
        "dynamodb:PutItem",
        "dynamodb:UpdateItem"
      ],
      "Resource": "arn:aws:dynamodb:us-east-1:240250534690:table/owed-*"
    },
    {
      "Sid": "WhoAmI",
      "Effect": "Allow",
      "Action": "sts:GetCallerIdentity",
      "Resource": "*"
    }
  ]
}
JSON
)

echo "==> running as"
aws sts get-caller-identity --output table

echo
echo "==> policy ${POLICY_NAME}"
if aws iam get-policy --policy-arn "$POLICY_ARN" >/dev/null 2>&1; then
	echo "    exists, left alone"
else
	aws iam create-policy \
		--policy-name "$POLICY_NAME" \
		--policy-document "$POLICY_DOCUMENT" \
		--description "Owed Phase 1: the ledger table and nothing else" \
		--output text --query 'Policy.Arn'
fi

echo
echo "==> user ${USER_NAME}"
if aws iam get-user --user-name "$USER_NAME" >/dev/null 2>&1; then
	echo "    exists, left alone"
else
	# No console password: this identity exists to run a CLI and should not be able to sign in.
	aws iam create-user --user-name "$USER_NAME" --output text --query 'User.Arn'
fi

aws iam attach-user-policy --user-name "$USER_NAME" --policy-arn "$POLICY_ARN"
echo "    policy attached"

echo
echo "==> access keys this user already has"
# AWS allows two per user and simply refuses a third. Listing first makes that visible
# rather than confusing.
aws iam list-access-keys --user-name "$USER_NAME" \
	--query 'AccessKeyMetadata[].{Id:AccessKeyId,Created:CreateDate,Status:Status}' \
	--output table

echo
echo "==> creating one"
aws iam create-access-key --user-name "$USER_NAME" \
	--query 'AccessKey.{AccessKeyId:AccessKeyId,SecretAccessKey:SecretAccessKey}' \
	--output table

cat <<EOF

Copy both values above, then on YOUR machine — not in CloudShell:

  aws configure
    AWS Access Key ID     : the AccessKeyId above
    AWS Secret Access Key : the SecretAccessKey above
    Default region name   : ${REGION}
    Default output format : json

  aws sts get-caller-identity          # expect Account ${ACCOUNT}

A read-only way to confirm the policy works, before writing anything:

  aws dynamodb describe-table --table-name owed-ledger --region ${REGION}
      ResourceNotFoundException  => permission is fine, the table just is not there yet
      AccessDeniedException      => the policy did not attach
  aws dynamodb list-tables --region ${REGION}
      AccessDeniedException      => correct. Least privilege is working.

The secret is shown once, here, and never again. If it is lost:

  aws iam delete-access-key --user-name ${USER_NAME} --access-key-id <old-id>

and run this again.

When the project is finished, remove the credential rather than leaving it to rot:

  aws iam delete-access-key  --user-name ${USER_NAME} --access-key-id <id>
  aws iam detach-user-policy --user-name ${USER_NAME} --policy-arn ${POLICY_ARN}
  aws iam delete-user        --user-name ${USER_NAME}
EOF
