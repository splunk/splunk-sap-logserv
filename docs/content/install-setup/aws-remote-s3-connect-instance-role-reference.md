# EC2 Instance Role: Reference

### :material-circle-box:{ .taiconcolor } Introduction

This page holds the detail behind [AWS Remote S3 Connect with an EC2 Instance Role](aws-remote-s3-connect-instance-role.md): what each heavy forwarder must allow, the access test, KMS keys, what to ask SAP, how this setup behaves in operation, hardening, and troubleshooting. Follow the setup page for the steps; come here when a step sends you.

It uses the same two names as the setup page: the **instance profile role** is the IAM role in the instance profile attached to each heavy forwarder EC2 instance, and **`splunk-logserv-ta-role`** is the IAM role that SAP's SQS queue access policy and S3 bucket policy name.

<br>

### :material-circle-box:{ .taiconcolor } Heavy Forwarder Requirements

The Splunk Add-on for AWS offers the instance profile role as an account only on a host where all of these hold. When one is missing the add-on says nothing: the account simply does not appear under **Configuration > Account**.

- **The host is an EC2 instance that you run,** not a Splunk Cloud instance. A heavy forwarder of your own on EC2 that forwards to Splunk Cloud qualifies.
- **An instance profile is attached** to the instance.
- **The Splunk user can reach the instance metadata service over IPv4,** at `169.254.169.254`. A host firewall rule that blocks the Splunk user stops the add-on even when the same check succeeds for root.
- **IMDSv2 can be required.** The add-on's metadata calls use a session token.
- **Hop limit:** 1 should be enough when Splunk runs directly on the instance. Splunk in a container on a bridged network should need a hop limit of 2, or host networking.
- **`AWS_EC2_METADATA_DISABLED` is not set** in splunkd's environment.
- **If splunkd's environment sets a proxy variable, `NO_PROXY` includes `169.254.169.254`.** Otherwise the metadata calls, and the credentials they return, go to the proxy. The add-on's **Configuration > Proxy** tab does not apply to these calls. See [Heavy Forwarders](../getting-started/prerequisites.md#heavy-forwarders) in Plan and Prerequisites.
- **Outbound HTTPS is open** to the AWS STS, Amazon SQS and Amazon S3 endpoints of the Region of SAP's queue.
- **Commercial AWS Regions.** For AWS GovCloud (US) or the China Regions, check with Splunk whether the add-on supports an instance profile there.

To check metadata access as the Splunk user (here named `splunk`):

```bash
sudo -u splunk bash -c 'TOKEN=$(curl -s --max-time 5 -X PUT \
    -H "X-aws-ec2-metadata-token-ttl-seconds: 60" http://169.254.169.254/latest/api/token)
  curl -s --max-time 5 -H "X-aws-ec2-metadata-token: $TOKEN" \
    http://169.254.169.254/latest/meta-data/iam/info'
```

The answer names the instance profile and holds no credentials. No answer, or a 404 page, means no instance profile or no access. Do not request the `security-credentials` path in a check: it prints the credentials. In a container, run the check inside the container.

That shell does not have splunkd's environment, so check it separately. This prints the names of any proxy variables, plus any `NO_PROXY` and `AWS_EC2_METADATA_DISABLED` lines:

```bash
pid=$(pgrep -o -x splunkd)
sudo cat "/proc/$pid/environ" | tr '\0' '\n' | grep -iE '^(http_proxy|https_proxy|all_proxy)=' | cut -d= -f1
sudo cat "/proc/$pid/environ" | tr '\0' '\n' | grep -iE '^(no_proxy|aws_ec2_metadata_disabled)='
```

**Add-on version.** Use the Splunk Add-on for AWS 8.2.2 or later. Splunk advisory <a href="https://advisory.splunk.com/advisories/SVD-2026-1005" target="_blank">SVD-2026-1005</a> says to upgrade to 8.2.2 or higher.

<br>

### :material-circle-box:{ .taiconcolor } Customer Managed KMS Keys

Ask SAP which encryption the S3 bucket and the SQS queue use. [Test Access](#test-access-from-the-heavy-forwarder) shows the queue's from your side too.

| SAP uses | What to do |
|---|---|
| SSE-S3 on the bucket, and SSE-SQS or no encryption on the queue | Nothing |
| A customer managed KMS key | Ask SAP for the key ARNs and to add `splunk-logserv-ta-role` to each key policy. Give the IAM role `kms:Decrypt` on those keys only (below) |
| An AWS managed key (`aws/s3` or `aws/sqs`) | It cannot be used from another AWS account. SAP must move the bucket or the queue to SSE-S3, SSE-SQS or a customer managed key. Objects already written with `aws/s3` stay unreadable until SAP copies them again |

**Scenario A:** update the CloudFormation stack, keep its template, and fill in **SapKmsKeyArns** with the key ARNs, separated by commas with no spaces. The update changes the inline policy and does not replace the IAM role.

**Scenarios B and C:** add this statement to the permissions policy of `splunk-logserv-ta-role`:

```json
{
  "Sid": "DecryptSapKeys",
  "Effect": "Allow",
  "Action": "kms:Decrypt",
  "Resource": [
    "arn:aws:kms:<region>:<sap-ecs-account-id>:key/<key-id>"
  ]
}
```

The statement SAP adds to each key policy:

```json
{
  "Sid": "AllowSplunkLogServRoleDecrypt",
  "Effect": "Allow",
  "Principal": {
    "AWS": "arn:aws:iam::<secondary-account-id>:role/splunk-logserv-ta-role"
  },
  "Action": "kms:Decrypt",
  "Resource": "*"
}
```

<br>

### :material-circle-box:{ .taiconcolor } What to Ask SAP

In the request of [step 4](aws-remote-s3-connect-instance-role.md#4-give-sap-the-iam-role-arn), ask SAP LogServ Support to:

- Add the statements that name your IAM role to its **existing** SQS queue access policy and S3 bucket policy. Each example file is a whole policy, and saving a policy replaces the one in place.
- Keep `s3:ListBucket` on the bucket ARN in the bucket policy. [AWS S3 Direct](aws-s3-direct.md) needs it.
- Say which encryption the bucket and the queue use ([Customer Managed KMS Keys](#customer-managed-kms-keys)).
- Confirm that the bucket's Object Ownership is **Bucket owner enforced.** With ACLs enabled, an object that another AWS account wrote can belong to that account, and the bucket policy cannot grant it to your IAM role.
- Confirm that **Requester Pays** is off on the bucket. The add-on does not send the requester-pays header.
- Confirm that the queue has a redrive policy (a dead-letter queue) and a visibility timeout of at least 300 seconds. The add-on's input form checks both.
- Say how old the oldest message in the queue is, and whether to purge the older messages ([First Start: The Queue Backlog](../getting-started/capacity-planning.md#first-start-the-queue-backlog)).

These ARNs look similar to the one SAP needs and are wrong:

| ARN | What it is |
|---|---|
| `arn:aws:iam::<account-id>:instance-profile/<name>` | The instance profile. The instance metadata service's `iam/info` shows this one |
| `arn:aws:sts::<account-id>:assumed-role/<role-name>/<session>` | A role session. `aws sts get-caller-identity` shows this one |
| `arn:aws:iam::<account-id>:role/<instance-profile-role-name>` | The instance profile role. It goes in the trust policy of `splunk-logserv-ta-role`, not to SAP |

<br>

### :material-circle-box:{ .taiconcolor } Test Access from the Heavy Forwarder

Run this on each heavy forwarder that will run the input, after SAP confirms its policies and before you create or switch the input. It uses the instance profile and assumes `splunk-logserv-ta-role`, as the add-on does, and it only reads.

It needs AWS CLI v2 on the heavy forwarder. If the forwarder reaches AWS through a proxy, set `HTTPS_PROXY` and `NO_PROXY=169.254.169.254` in the shell: the add-on's Proxy tab does not apply to the CLI.

**1.** Open a shell as the Splunk user and write a CLI profile in a private temporary folder. Keep this shell open until the clean-up.

```bash
sudo -u splunk -H bash
export PATH="/usr/local/bin:$PATH"
aws --version
umask 077
TEST_DIR=$(mktemp -d)
export AWS_CONFIG_FILE="$TEST_DIR/config"
cat > "$AWS_CONFIG_FILE" <<'EOF'
[profile logserv-test]
role_arn = arn:aws:iam::<secondary-account-id>:role/splunk-logserv-ta-role
credential_source = Ec2InstanceMetadata
role_session_name = splunk_ta_aws
region = <region-of-the-sap-queue>
sts_regional_endpoints = regional
EOF
aws sts get-caller-identity --profile logserv-test
```

`aws --version` should print `aws-cli/2`. The last command should show an `Arn` that ends in `assumed-role/splunk-logserv-ta-role/splunk_ta_aws`.

**2.** List a few objects, and pick a key whose size is above 0:

```bash
aws s3api list-objects-v2 --profile logserv-test --bucket <bucket-name> --prefix logserv/ \
  --max-items 5 --page-size 5 --query 'Contents[].[Size,Key]' --output text
```

**3.** Read the first 1 KB of that object. This also uses `kms:Decrypt` if the object is encrypted with SSE-KMS.

```bash
aws s3api get-object --profile logserv-test --bucket <bucket-name> \
  --key <key-from-the-listing> --range bytes=0-1023 "$TEST_DIR/object"
```

**4.** Read the queue's attributes:

```bash
aws sqs get-queue-attributes --profile logserv-test \
  --queue-url https://sqs.<region>.amazonaws.com/<sap-ecs-account-id>/<queue-name> \
  --attribute-names VisibilityTimeout RedrivePolicy ApproximateNumberOfMessages \
  KmsMasterKeyId SqsManagedSseEnabled
```

- `VisibilityTimeout` under 300, or no `RedrivePolicy`, blocks the input form unless SAP changes it ([Troubleshooting](#troubleshooting)).
- `ApproximateNumberOfMessages` is the backlog the input starts with.
- `SqsManagedSseEnabled` `true`, or no `KmsMasterKeyId`: no key to add for the queue. `KmsMasterKeyId` `alias/aws/sqs`: an AWS managed key, which your IAM role cannot use. Any other `KmsMasterKeyId`: a customer managed key ([Customer Managed KMS Keys](#customer-managed-kms-keys)).

:material-lightning-bolt:{ .taiconcolor } **Never run `aws sqs receive-message` for a test.** It hides the message from the input and counts as a delivery.

**5.** Clean up. The object holds SAP log data, and the CLI's cache holds the IAM role's temporary credentials. Do this before you test again after a policy change too, because the CLI reuses a cached session.

```bash
rm -rf "$TEST_DIR" ~/.aws/cli/cache
exit
```

If a command fails, its error names the call:

| The error names | Look at |
|---|---|
| `AssumeRole` | The trust policy of `splunk-logserv-ta-role` (it must name the instance profile role's ARN); the `sts:AssumeRole` statement on the instance profile role if that role is in another AWS account; then any service control policy or permissions boundary on either role |
| `InvalidClientTokenId` | The Region of SAP's queue may not be enabled in your account |
| Credentials from `Ec2InstanceMetadata` | [Heavy Forwarder Requirements](#heavy-forwarder-requirements) |
| `ListObjectsV2` | `s3:ListBucket` in the IAM role's permissions policy and in SAP's bucket policy. The SQS-Based S3 input does not need it, but AWS S3 Direct does. To go on with the object read, ask SAP for one object key |
| `GetObject` | `s3:GetObject` in the IAM role's permissions policy and in SAP's bucket policy, and the KMS key if SAP uses one. Then ask SAP whether the bucket owner owns the object and whether it uses the AWS managed key `aws/s3` |
| `GetQueueAttributes` | The IAM role's permissions policy, SAP's SQS queue access policy, the Region and the queue URL |

These commands do not test receiving or deleting messages, or decrypting with a key on the queue. Those show only when the input runs, so check the add-on's logs after you enable it.

<br>

### :material-circle-box:{ .taiconcolor } What the Permissions Policy Leaves Out

The permissions policy on the setup page, and in the instance-role CloudFormation template, is narrower than the one the standard Remote S3 Connect template creates. The SQS-Based S3 input works with it.

| Left out | Why |
|---|---|
| `kms:Decrypt` on `*` | It would reach every KMS key in your account whose key policy delegates to IAM. Name SAP's keys instead, and only if SAP uses them |
| `sqs:SendMessage` | The input never sends. A role that holds it could write a forged notification, and the input reads whatever object a notification names |
| `sqs:ListQueues` | It only fills the input form's dropdown, it needs `*`, and it cannot list a queue in another AWS account. Type the queue URL instead |
| `sqs:GetQueueUrl`, `s3:GetObjectAttributes` | The input does not call them |

If your version of the add-on will not save the input with a typed queue URL, add `sqs:ListQueues` on `*` to the IAM role while you create the input, and remove it afterwards.

SAP's example policies can stay as they are: a cross-account request needs an `Allow` on both sides, so an action your IAM role does not hold cannot be used from your side.

**Scenario B:** to narrow the policy the standard stack created, edit the inline policy `splunk-logserv-ta-policy` on `splunk-logserv-ta-role` in the IAM console, and replace it with the document in [C.2](aws-remote-s3-connect-instance-role.md#c2-the-permissions-policy).

<br>

### :material-circle-box:{ .taiconcolor } What Behaves Differently from a Stored Key

- **The add-on names the account after the instance profile role.** You cannot choose the name. A different instance profile on the instance means a different account name, and each input that holds the old name stops with `No AWS account named`. Edit each input, and add the new role to the trust policy of `splunk-logserv-ta-role`.
- **Every heavy forwarder that runs the input needs an instance profile.** One instance profile shared by the heavy forwarders is the simple way. Several instance profile roles mean several account names, and each needs its place in the trust policy. The CloudFormation template names one; add the others to the trust policy by hand, and again after any stack update that changes the trust policy.
- **The input restarts when the credentials rotate,** about once an hour. It stops taking new messages, exits, and starts again with the new credentials; notifications wait in SAP's queue meanwhile. The add-on logs the line `Content has been modified.` each time.
- **Keep `[assume_role] duration` at 3600 or below** in the add-on's `aws_settings.conf` (the default). AWS limits a session to one hour when one IAM role assumes another.
- **No `sts:ExternalId`.** The add-on sends none, so a trust policy that requires one blocks it. The add-on uses the role session name `splunk_ta_aws` on every heavy forwarder.
- **There is no access key to rotate.** [Rotate the Access Key](aws-remote-s3-connect-guide.md#rotate-the-access-key) in the main guide does not apply.
- **It adds no isolation.** Whatever can use the instance profile reaches SAP's data, so attach it only to the heavy forwarders.

#### :material-crop-square:{ .taiconcolor } Do Not Delete and Recreate the IAM Roles

AWS ties an ARN in a policy to the role's internal ID when the policy is saved. A new IAM role with the same name has a new ID, so the old grant no longer matches: the policy then shows an ID starting `AROA` where the ARN was, and its owner must put the ARN back and save the policy.

- For `splunk-logserv-ta-role`, that owner is SAP, for its S3 bucket policy, SQS queue access policy and KMS key policies. Splunk looks right while AWS answers `AccessDenied`.
- For the instance profile role, you fix the trust policy of `splunk-logserv-ta-role` yourself.

So update IAM roles in place, keep the CloudFormation stack that created `splunk-logserv-ta-role` with termination protection on, and check that your infrastructure code does not replace either role.

<br>

### :material-circle-box:{ .taiconcolor } Hardening for Your Security Review

:material-lightning-bolt:{ .taiconcolor } **Any process on the instance can fetch the instance profile's credentials from the instance metadata service.** Against that, there is no long-lived key: the credentials are temporary and rotate by themselves. Use this list to narrow the difference.

- **Attach the instance profile only to the heavy forwarders.** Any instance that holds it reaches SAP's data.
- **Require IMDSv2** on these instances (<a href="https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/configuring-instance-metadata-options.html" target="_blank">AWS: configure the instance metadata options</a>).
- **Limit metadata access to the Splunk user with a host firewall rule** (<a href="https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/instance-metadata-limiting-access.html" target="_blank">AWS: limit instance metadata access</a>), and make the rule persistent. Agents on the host that use the metadata service, such as the AWS Systems Manager agent, lose it. For example:

```bash
sudo iptables --append OUTPUT --proto tcp --destination 169.254.169.254 \
  --match owner ! --uid-owner splunk --jump REJECT
```

- **Limit who can pass the role.** Anyone who can attach the instance profile to an instance they control can use it. Scope `iam:PassRole`, `ec2:AssociateIamInstanceProfile` and `ec2:ReplaceIamInstanceProfileAssociation` for this role (<a href="https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/permission-to-pass-iam-roles.html" target="_blank">AWS: permission to pass a role</a>).
- **Review who can run commands on the heavy forwarders,** through a shell or AWS Systems Manager.
- **Limit who can sign in to Splunk on the heavy forwarders.** The add-on's REST interface can return an account's credentials, including temporary ones, to a signed-in user.

<br>

### :material-circle-box:{ .taiconcolor } Troubleshooting

| What you see | What it means | What to do |
|---|---|---|
| The account is not listed under **Configuration > Account** | No instance profile, or the Splunk user cannot reach the instance metadata service (firewall, proxy, hop limit in a container, `AWS_EC2_METADATA_DISABLED`), or the host is a Splunk Cloud instance | Run the check in [Heavy Forwarder Requirements](#heavy-forwarder-requirements) as the Splunk user. On a Splunk Cloud instance, use the IAM user in the main guide |
| Saving the input says `The SQS Queue entered may not be present in the given region.` | The add-on shows this for any failure of its queue check: a trust policy that does not name the instance profile role, a missing `sts:AssumeRole` statement on an instance profile role in another AWS account, SAP's SQS queue access policy not yet applied, or a wrong Region or URL | Run [Test Access](#test-access-from-the-heavy-forwarder). Its errors name the failing call |
| Saving the input says `AccessDenied` for `sts:AssumeRole`, and the message names the **same role** as the user (`assumed-role/<role-name>/<instance-id>`) and as the resource (`role/<role-name>`) | The role attached to the heavy forwarder instance is also the role selected in **Assume Role**, so it is asked to assume itself | Attach a separate instance profile role and let it assume this role (steps 2 and 3 of the setup page). Or, if the attached role already holds the queue and bucket permissions and is the role SAP's policies name, clear **Assume Role** on the input; this second way has not been run in our lab |
| The **SQS Queue Name** dropdown is empty or shows an error | Expected. It cannot list a queue in another AWS account | Type the queue URL |
| Saving the input says `Enabling dead letter queue is required for the SQS queue in this input.` | **Force using DLQ** is checked and SAP's queue has no redrive policy | Ask SAP to add one. Unchecking the box is the fallback, and it also skips the visibility check below |
| Saving the input says `It is recommended to set VisibilityTimeout larger than 5 minutes for specified SQS queue.` | This blocks the save, despite its wording: the queue's visibility timeout is under 300 seconds and **Force using DLQ** is checked | Ask SAP to raise it. Unchecking the box is the fallback |
| The input logs `Dead letter queue not found.` and stops | The same redrive check, when the input starts | As above |
| The input logs `No AWS account named` and `Data input was interrupted by an unhandled exception.` | The account the input names is gone: the instance profile changed, or the instance can no longer reach the instance metadata service | Restore the instance profile or the metadata access. If the role really changed, edit each input to the new account name and add the role to the trust policy |
| The input logs `Retrieve ec2 instance credentials failed.` | The instance metadata service gave the input no credentials | [Heavy Forwarder Requirements](#heavy-forwarder-requirements) |
| The input logs `Failed to download file.`, then `An error occurred while processing the message.` with `AccessDenied` in its traceback | The S3 or KMS side: the IAM role's permissions policy, SAP's bucket policy, or a key policy | **Disable the input at once.** Each failed message comes back with a higher receive count, and a redrive policy on SAP's queue can move the backlog to its dead-letter queue. Run [Test Access](#test-access-from-the-heavy-forwarder) and fix the cause first |
| The input logs `Failed to delete message.` | The IAM role or SAP's SQS queue access policy does not allow `sqs:DeleteMessage`. The events were already indexed, and the message comes back | **Disable the input at once**, because each redelivery indexes the file again. Fix the policy before you enable it |
| The input logs `Data input was interrupted by an unhandled exception.` with `AccessDenied` in its traceback | The call named there was denied: `AssumeRole` is the trust policy; `ReceiveMessage` or `GetQueueAttributes` is the IAM role's permissions policy, SAP's SQS queue access policy or a key on the queue | Run [Test Access](#test-access-from-the-heavy-forwarder), and fix what it shows |
| `AccessDenied` though every statement is right | A service control policy or resource control policy in your AWS Organization or SAP's, a permissions boundary on either role, or a VPC endpoint policy on the path to STS, SQS or S3. On SAP's side: an object another account owns, the AWS managed key `aws/s3` or `aws/sqs`, Requester Pays, or a SAP policy that shows an ID starting `AROA` because `splunk-logserv-ta-role` was deleted and created again | Ask your cloud team, and SAP for the causes on its side. The error message usually names the kind of policy that denied the call |
| Creating an AWS S3 Direct input logs `Error while getting region for bucket` | Expected. Neither the IAM role's permissions policy nor SAP's example allows `s3:GetBucketLocation`, and the input keeps the Region from the form | Nothing, unless objects fail with a Region error |

The other causes in step 8.d of the [main guide](aws-remote-s3-connect-guide.md#8-confirm-logserv-logs-are-being-ingested) apply too, except the access key.
