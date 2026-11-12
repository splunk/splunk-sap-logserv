# AWS Remote S3 Connect with an EC2 Instance Role

### :material-circle-box:{ .taiconcolor } Introduction

Use this page when your heavy forwarders run on EC2 and your security policy does not allow IAM users or long-lived access keys. It sets up the same scenario as the [AWS Remote S3 Connect Setup Guide](aws-remote-s3-connect-guide.md), with one change: the heavy forwarder's EC2 instance role takes the place of the IAM User and its access key. The Splunk Add-on for AWS gets temporary credentials from the instance metadata service, and no key is created in AWS or stored in Splunk.

!!! note "Status: what our lab has run"
    Our lab ran this setup from 2026-11-09 to 2026-11-11, with the heavy forwarder, the role, the queue and the bucket in one AWS account and Splunk Add-on for AWS 8.3.1. The template on this page was deployed and updated twice. An SQS-Based S3 input on the instance role, with `splunk-logserv-ta-role` under **Assume Role**, then ran for about 28 hours while the role held only this page's policy, and read 31,072 objects (556,510 events): 14 on the first day, and 31,058 on the second in three batches within about two hours. That policy is narrower than the list in Splunk's documentation for this input ([What This Policy Leaves Out](#what-this-policy-leaves-out)). Every object was read once and every line in it reached the index, and the input added no duplicate events and logged no AWS error. It logged 25 credential changes in that time, one of them while it was reading ([What Behaves Differently from a Stored Key](#what-behaves-differently-from-a-stored-key)). The input form saved such an input with the queue URL typed in, while the role still lacked `sqs:ListQueues`. Not yet run in our lab: an input process running longer than the role's one-hour session (every input process ended within the hour; the longest ran about 32 minutes), [AWS S3 Direct](aws-s3-direct.md) with an instance role, and the [alternative](#alternative-attach-the-policy-directly-to-the-instance-role). Splunk's documentation for the add-on describes an instance role as an account for the SQS-Based S3 input; it does not describe one used together with **Assume Role**, as this page does. Check your own heavy forwarder with [7. Test Access](#7-test-access) before you create the input.

This page uses the same two account names as the main guide: the **_SAP ECS account_** holds SAP's S3 Bucket and SQS Queue, and the **_Secondary account_** is yours.

<br>

### :material-circle-box:{ .taiconcolor } Who This Page Is For

Use this page when you run the heavy forwarder yourself, on an EC2 instance that has or can be given an instance role and can reach the metadata service ([What the Host Must Allow](#what-the-host-must-allow)). A heavy forwarder like that which forwards to Splunk Cloud should qualify, because the add-on's check looks at the local instance, not at where it forwards. We have not run that case.

Stay on the IAM User path in the [main guide](aws-remote-s3-connect-guide.md) when:

- **The input is hosted on Splunk Cloud.** The add-on does not offer the instance role on a Splunk Cloud instance.
- **The host is not on EC2.** The metadata service is the add-on's only source of credentials without a stored key.
- **The host is on EC2 but has no instance role or no metadata access.**

If your policy rules out an IAM User and your inputs run on one of those hosts, the way out is a heavy forwarder of your own on EC2 that forwards to your Splunk deployment.

The **Filter** and **Copy** scenarios still create the IAM User, and this page does not cover them. The legacy Connect to Filter migration tool also needs a real IAM User.

This page is written for commercial AWS Regions (the `aws` partition). Splunk's release notes have listed the instance role as unsupported in AWS China, and we do not know whether that still holds, so check with Splunk if you run there or in GovCloud.

<br>

### :material-circle-box:{ .taiconcolor } How It Works

```text
Secondary account                              SAP ECS account
+---------------------------------------+      +----------------------------+
|                                       |      |                            |
|  Heavy forwarder on EC2               |      |  SQS Queue and S3 Bucket   |
|    Splunk Add-on for AWS              |      |                            |
|    account: the instance role         |      |  Their policies name       |
|         |                             |      |  splunk-logserv-ta-role    |
|         | sts:AssumeRole              |      |                            |
|         v                             |      |                            |
|  IAM role splunk-logserv-ta-role  ---------->|                            |
|    reads the queue and the bucket     |      |                            |
|                                       |      |                            |
+---------------------------------------+      +----------------------------+
```

- The role `splunk-logserv-ta-role` stays in your **_Secondary account_**, under exactly that name. It holds the policy that reads SAP's queue and bucket. SAP's example policies name this role, so they stay valid.
- Its trust policy names the instance role.
- This setup gives the instance role only `sts:AssumeRole` on `splunk-logserv-ta-role`.
- In the **_SAP ECS account_**, SAP's queue policy and bucket policy, and the key policy of any customer-managed KMS key, name `splunk-logserv-ta-role`. Each read crosses the two accounts, so it needs an Allow on both sides: your role's policy and SAP's.
- In the add-on, the input uses the autodiscovered account (the instance role), with `splunk-logserv-ta-role` under **Assume Role**.

We recommend this setup for three reasons: SAP's example policies stay valid, [AWS S3 Direct](aws-s3-direct.md) accepts this setup on today's Data TA because a role is selected (going by the Data TA's code; our lab has not run it with an instance role), and if the instance role is ever replaced, you fix the trust policy yourself. The [alternative](#alternative-attach-the-policy-directly-to-the-instance-role) attaches the policy straight to the instance role, and it has costs.

:material-lightning-bolt:{ .taiconcolor } Neither setup adds isolation. Whatever can use the instance role reaches SAP's data either way, so use the instance role only on the heavy forwarders.

<br>

### :material-circle-box:{ .taiconcolor } What the Host Must Allow

Check these on each heavy forwarder. They come from reading the add-on's code and AWS's documentation. When one is missing, the add-on usually says nothing: the account does not appear, and the only trace is a debug line in its log.

- **An instance profile is attached** that holds the instance role.
- **The Splunk user can reach the metadata service over IPv4,** at `169.254.169.254`. The add-on has that address built in. A firewall rule that blocks the Splunk user stops the add-on even when the same check succeeds for root.
- **IMDSv2 required should be fine.** The add-on's own metadata calls use a token (read in its code, not run).
- **Hop limit.** Splunk running directly on the host should work with hop limit 1. Splunk in a container on a bridged network should need hop limit 2 or host networking (from AWS's documentation and the code, not run).
- **`AWS_EC2_METADATA_DISABLED` is not set** in splunkd's environment.
- **If splunkd's environment sets a proxy variable, `NO_PROXY` includes `169.254.169.254`.** Otherwise the metadata calls, and the credentials they return, go to the proxy. The add-on's **Configuration > Proxy** tab does not apply to these calls; it applies to its STS, SQS and S3 calls. See [Heavy Forwarders](../getting-started/prerequisites.md#heavy-forwarders) in Plan and Prerequisites.
- **Outbound HTTPS is open** to the STS, SQS and S3 endpoints of the Region of SAP's queue.

To check metadata access as the Splunk user (here named `splunk`):

```bash
sudo -u splunk bash -c 'TOKEN=$(curl -s --max-time 5 -X PUT \
    -H "X-aws-ec2-metadata-token-ttl-seconds: 60" http://169.254.169.254/latest/api/token)
  curl -s --max-time 5 -H "X-aws-ec2-metadata-token: $TOKEN" \
    http://169.254.169.254/latest/meta-data/iam/info'
```

The answer names the instance profile and holds no credentials. No answer, or a 404 page, means no instance profile or no access. Do not request the `security-credentials` path in a check: it prints the credentials. In a container, run the same check inside the container. This shell does not have splunkd's environment, so check that separately. This prints proxy variable names only, plus any `NO_PROXY` and `AWS_EC2_METADATA_DISABLED` lines:

```bash
pid=$(pgrep -o -x splunkd)
sudo cat "/proc/$pid/environ" | tr '\0' '\n' | grep -iE '^(http_proxy|all_proxy)=' | cut -d= -f1
sudo cat "/proc/$pid/environ" | tr '\0' '\n' | grep -iE '^(no_proxy|aws_ec2_metadata_disabled)='
```

<br>

### :material-circle-box:{ .taiconcolor } Add-on Version

Use the Splunk Add-on for AWS **8.2.2 or later, and not 8.3.0**. 8.3.1 is the version whose code we read. Splunk advisory <a href="https://advisory.splunk.com/advisories/SVD-2026-1005" target="_blank">SVD-2026-1005</a> says to upgrade to 8.2.2 or higher, Splunk's release notes record a fix in 8.1.2 for recurring `ExpiredToken` errors in SQS-Based S3 inputs that assume a role, and 8.3.0 has a known throughput problem (ADDON-91143).

Install it directly on each heavy forwarder, as [Install the Splunk Add-on for AWS](aws-remote-s3-connect-guide.md#install-the-splunk-add-on-for-aws) in the main guide says.

<br>

### :material-circle-box:{ .taiconcolor } High Level Steps

:material-lightning-bolt:{ .taiconcolor } Your AWS sign-in needs to create IAM roles and inline policies (and CloudFormation stacks on route 1), `iam:CreateInstanceProfile` and `iam:AddRoleToInstanceProfile` if you create a new instance role in step 2, plus `iam:PassRole` and `ec2:AssociateIamInstanceProfile` or `ec2:ReplaceIamInstanceProfileAssociation` on the heavy forwarders.

- **Before you begin:** [Check These First](aws-remote-s3-connect-guide.md#check-these-first) in the main guide applies here too: the prerequisites, the Data TA, cloud attribution, filtering and the first start. Its step numbers are the main guide's: check these before step 5 here, and read the first-start item before step 8.

1. Obtain the ARNs of SAP's S3 Bucket and SQS Queue, and confirm that the Region of the queue is enabled in your **_Secondary account_**
2. Create the instance role and attach it to each heavy forwarder
3. Create the role `splunk-logserv-ta-role`, with the <a href="https://github.com/splunk/splunk-sap-logserv/blob/main/aws_assets/cloud_formation/splunk-logserv-remote-s3-connect-instance-role.yaml" target="_blank">CloudFormation Template</a> or by hand, and let the instance role assume it
4. Give SAP LogServ Support the role's ARN, and wait for SAP to confirm that both policies are applied
5. Confirm that the instance role appears as an account in the Splunk Add-on for AWS
6. Configure the IAM Role in the add-on
7. Test access from the heavy forwarder
8. Create the SQS-Based S3 Input, with its cloud attribution
9. Confirm that LogServ logs are being ingested

#### :material-crop-square:{ .taiconcolor } Where These Steps Run

| Steps | Where |
|---|---|
| 1 to 4 | The AWS console of your **_Secondary account_**, and a request to SAP LogServ Support |
| 5, 6 and 8 | Splunk Web on each heavy forwarder that will run the input. Configure each one directly, not through a Deployment Server |
| 7 | A shell on each heavy forwarder that will run the input |
| 9 | A search head that can search the LogServ data index |

Several heavy forwarders can read the same SQS Queue: the queue hands each message to one of them. Attach the same instance role to each, and give each the same IAM Role and input. See [Add Heavy Forwarders on the Same Queue](../getting-started/capacity-planning.md#add-heavy-forwarders-on-the-same-queue).

<br>

### :material-circle-box:{ .taiconcolor } 1. Obtain ARNs and Confirm the Region

1.<b class="taiconcolor">a</b> Obtain the ARN of the S3 Bucket, the ARN of the SQS Queue and their AWS Region, as in [1. Obtain ARNs from SAP ECS Account](aws-remote-s3-connect-guide.md#1-obtain-arns-from-sap-ecs-account) in the main guide.

1.<b class="taiconcolor">b</b> In the AWS console of your **_Secondary account_**, open your account settings and check under **AWS Regions** that the Region of SAP's queue is enabled. Some Regions are off until you enable them. Route 2 of step 3 creates only IAM roles, which are global, so nothing there would show that the Region is off. The add-on calls STS and SQS at the endpoints of that Region, so a Region that is off may make those calls fail. If SAP uses a customer-managed KMS key, SAP's grant on it takes effect only while that Region is enabled in your account.

<br>

### :material-circle-box:{ .taiconcolor } 2. Create the Instance Role

Do this first: the trust policy in step 3 names this role, so it must exist.

2.<b class="taiconcolor">a</b> An EC2 instance holds one role at a time. If your heavy forwarders already have a role that only they use, keep it and go to step 2.c. Otherwise, in the IAM console of your **_Secondary account_**, click **Roles**, then **Create role**. Choose **AWS service** as the trusted entity and **EC2** as the use case. Add no permissions for this setup at this point. Give the role a name of your own, and create it. If the instance already has a role, the new role replaces it, and the instance loses that role's permissions. Before you swap, attach to the new role what the instance still needs, for example the managed policy for Systems Manager.

2.<b class="taiconcolor">b</b> Attach the role to each heavy forwarder: in the EC2 console, select the instance, then **Actions > Security > Modify IAM role**. Add the same instance profile to the launch template of any heavy forwarder you build later. Splunk should not need a restart, because the add-on looks for the role each time it lists its accounts (read in its code, not run).

2.<b class="taiconcolor">c</b> Open the role's page in the IAM console and copy its ARN. It looks like `arn:aws:iam::<account-id>:role/<instance-role-name>`, with any path the role has before its name. You need it in step 3.

<br>

### :material-circle-box:{ .taiconcolor } 3. Create the Role splunk-logserv-ta-role

Use either route below. Keep the name `splunk-logserv-ta-role` exactly: SAP's example policies name it. Then do [Let the Instance Role Assume It](#let-the-instance-role-assume-it).

#### :material-crop-square:{ .taiconcolor } Route 1: Deploy the Template

3.<b class="taiconcolor">a</b> In the CloudFormation console of your **_Secondary account_**, in the Region of SAP's queue, click **Create stack**, then **With new resources (standard)**.

3.<b class="taiconcolor">b</b> Upload the <a href="https://github.com/splunk/splunk-sap-logserv/blob/main/aws_assets/cloud_formation/splunk-logserv-remote-s3-connect-instance-role.yaml" target="_blank">CloudFormation Template file provided</a> for this path, then click **Next**. It creates no IAM User and no access key.

3.<b class="taiconcolor">c</b> Name the stack, for example `splunk-logserv-remote-s3-connect-instance-role`, and enter its parameters, then click **Next**:

- **CrossAccountSQSQueueArn:** the complete ARN of the SQS Queue in your **_SAP ECS account_**.
- **CrossAccountS3Bucket:** just the name (not the ARN) of the S3 Bucket in your **_SAP ECS account_**.
- **SapKmsKeyArns:** leave it blank unless SAP uses a customer-managed KMS key ([below](#if-sap-uses-a-customer-managed-kms-key)).
- **HeavyForwarderInstanceRoleArn:** the ARN of the instance role from step 2.c.
- **HeavyForwarderInstanceRoleName:** optional. The name of the same role, without any path. When you fill it in, the stack gives that role `sts:AssumeRole` on `splunk-logserv-ta-role`. Leave it blank if the role is in another account, where you add the statement yourself ([Let the Instance Role Assume It](#let-the-instance-role-assume-it)), or if you prefer to add it by hand.

3.<b class="taiconcolor">d</b> Check the box **I acknowledge that AWS CloudFormation might create IAM resources with custom names**, click **Next**, then **Submit**, and wait until the stack completes. Its output `SplunkLogServRoleArn` is the ARN for step 4, and `InstanceRoleGrant` says whether the stack gave the instance role its statement.

To fill in **HeavyForwarderInstanceRoleName** or **SapKmsKeyArns** later, update the stack, keep its template, and change only those parameters. Neither replaces the role, going by AWS's documentation: the key ARNs change its inline policy, and the name adds or removes a separate policy on the instance role. In our lab, a stack created with both blank took an update that filled in both and one that cleared the key, each through a change set. Turn on termination protection for the stack (**Stack actions > Edit termination protection**): it is off by default, and deleting the stack deletes the role ([What Behaves Differently from a Stored Key](#what-behaves-differently-from-a-stored-key)).

The role name is fixed, so a new stack cannot be created in an account that already has a role with that name. What to do depends on where that role came from. Neither of these two ways has been run:

- **It came from the standard Connect template.** First disable the inputs that use the IAM User's access key and delete that key: CloudFormation may otherwise fail to delete the user and leave it in the account. Then update that stack with this template (select the stack, then **Update**, then **Replace current template**), and enter the parameters of step 3.c. The role keeps its name and ID, so SAP's grant keeps matching. Then point the inputs at the instance-role account: confirm the account (step 5), and select it as **AWS Account** on each input (step 8.b). After that edit, check the `_meta` line (step 8.e).
- **It was not made by a stack.** Edit its trust policy and inline policy by hand to match route 2, and do not delete it.

Never update a Filter or Copy stack with this template. Those stacks use the same role name, and the update would delete what else they create.

#### :material-crop-square:{ .taiconcolor } Route 2: Create the Role by Hand

3.<b class="taiconcolor">e</b> In the IAM console, click **Roles**, then **Create role**. Choose **Custom trust policy** and paste the policy below, with the ARN from step 2.c. It carries no `sts:ExternalId` condition, because the add-on sends none. If you add a condition on the session name, it must allow `splunk_ta_aws`.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "AWS": "arn:aws:iam::<account-id>:role/<instance-role-name>"
      },
      "Action": "sts:AssumeRole"
    }
  ]
}
```

3.<b class="taiconcolor">f</b> Name the role `splunk-logserv-ta-role` and create it.

3.<b class="taiconcolor">g</b> On the role's page, click **Add permissions**, then **Create inline policy**, choose **JSON**, and paste the policy below with SAP's values. Name it `splunk-logserv-ta-policy`.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "ReadSapQueue",
      "Effect": "Allow",
      "Action": [
        "sqs:ReceiveMessage",
        "sqs:DeleteMessage",
        "sqs:ChangeMessageVisibility",
        "sqs:GetQueueAttributes"
      ],
      "Resource": "arn:aws:sqs:<region>:<sap-ecs-account-id>:<queue-name>"
    },
    {
      "Sid": "ReadSapObjects",
      "Effect": "Allow",
      "Action": [
        "s3:GetObject",
        "s3:GetObjectVersion"
      ],
      "Resource": "arn:aws:s3:::<bucket-name>/*"
    },
    {
      "Sid": "ListSapBucket",
      "Effect": "Allow",
      "Action": "s3:ListBucket",
      "Resource": "arn:aws:s3:::<bucket-name>"
    }
  ]
}
```

The SQS-Based S3 input does not need `s3:ListBucket`. [AWS S3 Direct](aws-s3-direct.md), which loads history and recovers outages, does.

#### :material-crop-square:{ .taiconcolor } Let the Instance Role Assume It

If the stack's output `InstanceRoleGrant` says **Attached by this stack**, this is done. Otherwise, open the instance role's page in the IAM console of the account that holds it, click **Add permissions**, then **Create inline policy**, choose **JSON**, and paste this, with the ARN of `splunk-logserv-ta-role`. It is the only permission this setup gives the instance role.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": "sts:AssumeRole",
      "Resource": "arn:aws:iam::<secondary-account-id>:role/splunk-logserv-ta-role"
    }
  ]
}
```

Name it `splunk-logserv-sqs-based-input-assume-role-policy`, the name the stack uses.

When the instance role is in the same account as `splunk-logserv-ta-role`, the usual case, the trust policy alone already lets it assume the role: AWS needs no identity-based permission for a principal that a resource-based policy, here the trust policy, names in its own account (<a href="https://docs.aws.amazon.com/STS/latest/APIReference/API_AssumeRole.html" target="_blank">AWS: AssumeRole</a>). In our lab, with both roles in one account, the add-on's queue check, which assumes the role, passed before this statement existed. Add the statement anyway: it records on the instance role what it may assume. When the instance role is in another of your accounts, the statement is required: add it in that account, which the stack cannot do, and that account's SCPs and permissions boundaries apply too. In the same account, removing the statement does not stop the instance role: remove the instance role from the trust policy, or add an explicit `Deny` on the instance role.

#### :material-crop-square:{ .taiconcolor } If SAP Uses a Customer-Managed KMS Key

Ask SAP which encryption the bucket and the queue use (step 4). Step 7 shows it from your side too.

- **SSE-S3 on the bucket, and SSE-SQS or none on the queue:** add nothing.
- **A customer-managed KMS key:** ask SAP for the key ARNs and to add `splunk-logserv-ta-role` to each key's policy, and grant the role `kms:Decrypt` on those keys only. If you deployed the template, update the stack in place and fill in **SapKmsKeyArns**, with the key ARNs separated by commas and no spaces. If you created the role by hand, add the first statement below to its policy.
- **An AWS managed key (`aws/s3` or `aws/sqs`):** it cannot be used from another account, and nothing on your side changes that. SAP must move the bucket or the queue to SSE-S3, SSE-SQS or a customer-managed key. Objects already written with `aws/s3` stay unreadable until SAP copies them again, which matters for history loaded with [AWS S3 Direct](aws-s3-direct.md).

The statement for your role:

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

The statement SAP adds to each key policy. In a key policy, `"Resource": "*"` means the key itself:

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

#### :material-crop-square:{ .taiconcolor } What This Policy Leaves Out

The standard Connect template grants a few more actions, and they are left out on purpose. <a href="https://splunk.github.io/splunk-add-on-for-amazon-web-services/SQS-basedS3/" target="_blank">Splunk's documentation for this input</a> lists `sqs:GetQueueUrl`, `sqs:SendMessage`, `sqs:ListQueues` and `kms:Decrypt` too, so this policy is narrower than that list as well. In our lab, with the heavy forwarder, the role, the queue and the bucket in one AWS account and Splunk Add-on for AWS 8.3.1, an SQS-Based S3 input read its queue and bucket while the role held only this policy.

| Left out | Why |
|---|---|
| `kms:Decrypt` on `*` | It would reach every KMS key in your account whose key policy delegates to IAM. Name SAP's keys instead, and only if SAP uses them |
| `sqs:SendMessage` | The input never sends. A role that holds it could write a forged notification, and the input reads whatever object a notification names |
| `sqs:ListQueues` | It only fills the form's dropdown, it needs `*`, and it cannot show another account's queue. On the input form the dropdown stays empty, and you type the queue URL (step 8.c). In our lab the add-on's call for that list was refused with `AccessDenied` for this role, the form saved with the URL typed in, and the input ran without it |
| `sqs:GetQueueUrl`, `s3:GetObjectAttributes` | The input does not call them |

SAP's example policies can stay as they are. A cross-account request needs an Allow on both sides, so an action your role does not hold cannot be used from your side.

<br>

### :material-circle-box:{ .taiconcolor } 4. Give SAP the Role ARN

4.<b class="taiconcolor">a</b> In the IAM console, open the role `splunk-logserv-ta-role` and copy its ARN from the role's page. Copy it rather than building it from a name. It looks like this:

`arn:aws:iam::<secondary-account-id>:role/splunk-logserv-ta-role`

These look similar and are wrong for SAP:

| ARN | What it is |
|---|---|
| `arn:aws:iam::<account-id>:instance-profile/<name>` | The instance profile. The metadata service's `iam/info` shows this one |
| `arn:aws:sts::<account-id>:assumed-role/<role-name>/<session>` | A session, not a role. `aws sts get-caller-identity` shows this one |
| `arn:aws:iam::<account-id>:role/<instance-role-name>` | The instance role. It goes in the trust policy of step 3. SAP does not need it on this path |

4.<b class="taiconcolor">b</b> Contact SAP LogServ Support and ask them to apply the access policies for the <a href="https://github.com/splunk/splunk-sap-logserv/blob/main/aws_assets/sap_ecs_account_policies/sap-ecs-account-sqs-access-policy.json" target="_blank">SQS Queue</a> and the <a href="https://github.com/splunk/splunk-sap-logserv/blob/main/aws_assets/sap_ecs_account_policies/sap-ecs-account-s3-access-policy.json" target="_blank">S3 Bucket</a> for that ARN. Each example is a whole policy, and saving a policy replaces the one in place, so SAP adds the statements that name your role to its existing queue and bucket policies. In the same request, ask them:

- To keep `s3:ListBucket` on the bucket ARN in the bucket policy, as the example does. [AWS S3 Direct](aws-s3-direct.md) needs it.
- Which encryption the bucket and the queue use. With a customer-managed KMS key, ask for the key ARNs, and ask SAP to add `splunk-logserv-ta-role` to each key policy. An AWS managed key cannot be used from your account ([If SAP Uses a Customer-Managed KMS Key](#if-sap-uses-a-customer-managed-kms-key)).
- That the bucket's Object Ownership is **Bucket owner enforced**, the default for new buckets. With ACLs enabled, an object that another account wrote can belong to that account, and SAP's bucket policy cannot grant such an object to your role.
- That Requester Pays is off on the bucket. The add-on does not send the requester-pays header, so S3 would refuse its reads (read in its code, not run).
- Whether the queue has a redrive policy and a visibility timeout of at least 300 seconds. The add-on's form checks both ([Troubleshooting](#troubleshooting)).
- How old the oldest message in the queue is, and whether to purge the older messages ([First Start: The Queue Backlog](../getting-started/capacity-planning.md#first-start-the-queue-backlog)).

:material-lightning-bolt:{ .taiconcolor } **Wait until SAP LogServ Support confirms that the policies are applied** before you run step 7 or create the input in step 8. Steps 5 and 6 can be done in the meantime.

<br>

### :material-circle-box:{ .taiconcolor } 5. Confirm the Account in the Add-on

:material-lightning-bolt:{ .taiconcolor } Do steps 5 to 8 on each heavy forwarder that will run the input ([Where These Steps Run](#where-these-steps-run)).

5.<b class="taiconcolor">a</b> Log in to Splunk Web on the heavy forwarder with a Splunk admin role, open the **Splunk Add-on for AWS** app, then click **Configuration**, then **Account**. The first time the add-on lists the role it writes a small entry to its own configuration and a record to its account index (`index=summary`), so an admin role should open this page first.

5.<b class="taiconcolor">b</b> Look for a row named after the instance role, with **Yes** in the **Autodiscovered IAM Role** column. Its **Key ID** cell should show a temporary key ID, usually starting `ASIA`, read from the metadata service. No key is stored. You do not add this account, and you cannot delete it. Its Region Category is detected, so there is nothing to set. If no such row appears, see [Troubleshooting](#troubleshooting).

<br>

### :material-circle-box:{ .taiconcolor } 6. Configure the IAM Role in the Add-on

6.<b class="taiconcolor">a</b> Click the **IAM Role** tab to the right of the Account tab, then click **Add**.

6.<b class="taiconcolor">b</b> Enter a descriptive name in the **Name** field, using only letters, digits and underscores (the form refuses a hyphen), for example `splunk_logserv_ta_role`, and the ARN of `splunk-logserv-ta-role` in the **IAM Role ARN** field, then click **Add**. Step 6 of the [main guide](aws-remote-s3-connect-guide.md#6-configure-iam-role-aws-add-on) has screenshots of this form.

<br>

### :material-circle-box:{ .taiconcolor } 7. Test Access

When you save the input, the form's check tests only SQS. A missing S3 or KMS permission passes that check and shows up when the input runs, after notifications have started to come back again and again. So test S3 yourself first, from the heavy forwarder, with the same role.

Run this test on each heavy forwarder that will run the input, before you create the input, because the input starts reading as soon as you click **Add**. Apart from opening the Account page the first time (step 5.a), everything in this test only reads.

This step needs AWS CLI v2 on the heavy forwarder. The add-on does not include it. If the forwarder reaches AWS through a proxy, set `HTTPS_PROXY` and `NO_PROXY=169.254.169.254` in the shell: the add-on's Proxy tab does not apply to the CLI.

7.<b class="taiconcolor">a</b> Open a shell as the Splunk user (the first line below). In a private temporary folder, write a CLI profile that starts from the instance role and assumes `splunk-logserv-ta-role`, as the add-on does. Keep this shell open through step 7.e.

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

`aws --version` should print `aws-cli/2`. The last command should show an `Arn` that ends in `assumed-role/splunk-logserv-ta-role/splunk_ta_aws`, the role and session name the add-on uses.

7.<b class="taiconcolor">b</b> List a few objects:

```bash
aws s3api list-objects-v2 --profile logserv-test --bucket <bucket-name> --prefix logserv/ \
  --max-items 5 --page-size 5 --query 'Contents[].[Size,Key]' --output text
```

Pick a key whose size is above 0. A `None` as the last line only means there are more objects.

7.<b class="taiconcolor">c</b> Read the start of that object into the temporary folder. This reads at most the first 1 KB. It still uses `kms:Decrypt` if the object is encrypted with SSE-KMS.

```bash
aws s3api get-object --profile logserv-test --bucket <bucket-name> \
  --key <key-from-the-listing> --range bytes=0-1023 "$TEST_DIR/object"
```

7.<b class="taiconcolor">d</b> Read the queue's attributes:

```bash
aws sqs get-queue-attributes --profile logserv-test \
  --queue-url https://sqs.<region>.amazonaws.com/<sap-ecs-account-id>/<queue-name> \
  --attribute-names VisibilityTimeout RedrivePolicy ApproximateNumberOfMessages \
  KmsMasterKeyId SqsManagedSseEnabled
```

- `VisibilityTimeout` under 300, or no `RedrivePolicy`, will block the form in step 8 unless SAP changes it ([Troubleshooting](#troubleshooting)).
- `ApproximateNumberOfMessages` sizes the backlog the input starts with ([First Start: The Queue Backlog](../getting-started/capacity-planning.md#first-start-the-queue-backlog)).
- `SqsManagedSseEnabled` `true`, or no `KmsMasterKeyId`: no key to add for the queue. `KmsMasterKeyId` `alias/aws/sqs`: an AWS managed key, which your role cannot use, so ask SAP. Any other `KmsMasterKeyId`: a customer-managed key, so ask SAP for its key ARN ([If SAP Uses a Customer-Managed KMS Key](#if-sap-uses-a-customer-managed-kms-key)).

:material-lightning-bolt:{ .taiconcolor } **Never run `aws sqs receive-message` for a test.** It hides the message from the input and counts as a delivery.

7.<b class="taiconcolor">e</b> Clean up. The object holds SAP log data, and the CLI's cache under the user's home directory holds the role's temporary credentials. This removes both. It also clears any other CLI sessions that user had cached. To test again after a policy change, do this clean up first, because the CLI can reuse the cached session. Then start again at step 7.a.

```bash
rm -rf "$TEST_DIR" ~/.aws/cli/cache
exit
```

If a command fails, its error names the call:

| The error names | Look at |
|---|---|
| `AssumeRole` | The trust policy of `splunk-logserv-ta-role` (it must name the instance role's ARN), the `sts:AssumeRole` statement on the instance role if that role is in another account, then any SCP or permissions boundary on either role |
| `InvalidClientTokenId` | The Region of SAP's queue may not be enabled in your account (step 1.b) |
| Credentials from `Ec2InstanceMetadata` | [What the Host Must Allow](#what-the-host-must-allow) |
| `ListObjectsV2` | `s3:ListBucket` in your role's policy and in SAP's bucket policy. The input does not need it, but AWS S3 Direct does. To go on with step 7.c, ask SAP for one object key |
| `GetObject` | `s3:GetObject` in your role's policy and in SAP's bucket policy, and the KMS key if SAP uses one. If those are right, ask SAP whether the object is owned by the bucket's owner and whether it uses the AWS managed key `aws/s3` |
| `GetQueueAttributes` | Your role's policy, SAP's queue policy, the Region and the queue URL |

These commands do not test receiving or deleting messages, or decrypting with a key on the queue: step 7.d shows which key the queue uses, not that your role can use it. Those show only when the input runs.

<br>

### :material-circle-box:{ .taiconcolor } 8. Create the SQS-Based S3 Input

:material-lightning-bolt:{ .taiconcolor } Create the input only after SAP LogServ Support has confirmed that the policies from step 4 are applied, after step 7 passes, and after the Data TA is on this instance ([Check These First](aws-remote-s3-connect-guide.md#check-these-first)).

:material-lightning-bolt:{ .taiconcolor } Once added, the input starts with every notification already waiting in the SQS Queue in your **_SAP ECS account_** (up to 14 days of them), on top of the live feed. Before you add it, see [First Start: The Queue Backlog](../getting-started/capacity-planning.md#first-start-the-queue-backlog), which includes asking SAP to purge the older messages.

Step 7 of the [main guide](aws-remote-s3-connect-guide.md#7-configure-sqs-based-s3-input-aws-add-on) has screenshots of this form.

8.<b class="taiconcolor">a</b> Click the **Inputs** tab, then **Create New Input**. Select **Custom Data Type** at the bottom of the drop-down, then **SQS-Based S3 (Recommended)**.

8.<b class="taiconcolor">b</b> Fill out the first fields:

- **Name:** a descriptive name for the input.
- **AWS Account:** the account named after the instance role, from step 5.
- **Assume Role:** the IAM Role from step 6.
- **Force using DLQ (Recommended):** leave it checked.
- **AWS Region:** the Region of SAP's queue.
- **Use Private Endpoints:** leave it unchecked.

8.<b class="taiconcolor">c</b> In **SQS Queue Name**, type the **URL** of the SQS Queue in your **_SAP ECS account_**, not the ARN or just the name. `sqs:ListQueues` is left out of the policy on purpose, so the dropdown cannot list queues: in our lab it showed **No matches**, with no error on the page. It could not list another account's queue in any case.

- If the ARN looks like this: `arn:aws:sqs:<region>:<sap-ecs-account-id>:<queue-name>`
- Type the URL like this: `https://sqs.<region>.amazonaws.com/<sap-ecs-account-id>/<queue-name>`

The field takes a typed value: type the URL, then select it where the list offers it as **(New value)**. In our lab the form saved this way, with the role as this page leaves it. If your version of the add-on will not save it, add `sqs:ListQueues` on `*` to the policy of `splunk-logserv-ta-role` while you create the input, remove it straight after, and tell us. That is what the standard template grants.

8.<b class="taiconcolor">d</b> Fill out the remaining fields:

- **SQS Batch Size:** leave it at 10.
- **S3 File Decoder:** Custom Logs.
- **Signature Validate All Events:** **uncheck** it. SAP's queue receives the S3 notifications directly, not through SNS, so they carry no SNS signature.
- **Source Type:** `sap_logserv_logs`.
- **Index:** `sap_logserv_logs`, or the name you gave the LogServ data index ([Renaming an Index](install-ta.md#renaming-an-index)).

Click **Add**.

8.<b class="taiconcolor">e</b> Add the cloud attribution, as in step 7.f of the main guide. Leave the Data TA's **Cloud Provider** dropdown at **Not set**. The form has no field for the stamp, and the input starts reading as soon as you click **Add**, so:

- On the **Inputs** tab, disable the new input straight away.
- Add this line to the input's stanza, `[aws_sqs_based_s3://<input name>]`, in `$SPLUNK_HOME/etc/apps/Splunk_TA_aws/local/inputs.conf`:

```ini
_meta = cloud_provider::aws
```

- Restart Splunk, then enable the input on the **Inputs** tab.
- After any later edit of this input in the form, check that the line is still there.

Instead of the file and the restart, you can write the line over REST to the heavy forwarder's management port, with an account that holds the `admin_all_objects` capability, then disable and enable the input on the **Inputs** tab:

```bash
STANZA='aws_sqs_based_s3%3A%2F%2F<input_name>'
curl -k -u <admin_user> -d "_meta=cloud_provider::aws" \
  "https://localhost:8089/servicesNS/nobody/Splunk_TA_aws/configs/conf-inputs/$STANZA"
```

In our lab, on a heavy forwarder with Splunk Add-on for AWS 8.3.1, that stamped `aws` on every event the new input then read, with no restart.

See [Add the `_meta` Line to an AWS Input](cloud-attribution.md#add-the-meta-line-to-an-aws-input) and [Check the Result](cloud-attribution.md#check-the-result).

<br>

### :material-circle-box:{ .taiconcolor } 9. Confirm LogServ Logs are Being Ingested

As in the main guide, allow 5-10 minutes for the first events. The input polls at its interval (default 300 seconds).

9.<b class="taiconcolor">a</b> On a search head that can search the LogServ data index, run this search, with the name you gave the index if you renamed it:

    index=sap_logserv_logs earliest=-1h | stats count by sourcetype, host

9.<b class="taiconcolor">b</b> You should see the LogServ sourcetypes your SAP LogServ subscription delivers, from several hosts. [Verify Your Data](../getting-started/verify-data.md) has the full set of checks.

9.<b class="taiconcolor">c</b> Even if events arrive, check the add-on's logs with the search below and compare what you find with [Troubleshooting](#troubleshooting). A permission problem on some objects does not stop the others.

    index=_internal source=*aws* level IN (ERROR,WARNING) earliest=-1h | head 50

<br>

### :material-circle-box:{ .taiconcolor } Alternative: Attach the Policy Directly to the Instance Role

The policy of step 3.g, and the KMS statement if you need it, can go straight on the instance role, with no `splunk-logserv-ta-role` and no **Assume Role**. The add-on's code supports this too. Our lab has not run it.

The steps change like this:

- Steps 1 and 2 stay the same.
- In place of step 3, attach the policy to the instance role.
- In step 4, give SAP the ARN of the instance role, and if SAP uses a customer-managed KMS key, ask SAP to name that same role in each key policy.
- Step 5 stays the same. Skip step 6.
- In step 7, leave `role_arn`, `credential_source` and `role_session_name` out of the profile, so the CLI uses the instance role itself. `aws sts get-caller-identity` should then show `assumed-role/` and the instance role's name.
- In step 8, leave **Assume Role** empty.

It saves one role and the assume step. It costs this:

- **SAP must name the instance role.** SAP's example policies name only `splunk-logserv-ta-role`, so SAP must change the principal. We do not know whether SAP accepts another role's ARN, so ask before you commit to this.
- **AWS S3 Direct refuses it today.** With no role selected, the screen shows a hard error, has no **Create** button and generates nothing. So loading history needs a later Data TA build, or a stanza written by hand as in [A4](aws-s3-direct.md#a4-run-once-backfill-procedure-by-hand) with `aws_iam_role` left out (the add-on's code allows it; our lab has not run it). A3's advice to always set both does not apply on this path.
- **Replacing the role needs SAP.** If the instance role is ever deleted and recreated, ingest stops until SAP puts the role's ARN back in its policies. On the recommended path you fix this in your own trust policy.
- **It adds no isolation.** Whatever can use the instance role reaches SAP's data, on either path.

<br>

### :material-circle-box:{ .taiconcolor } What Behaves Differently from a Stored Key

- **The account is named after the instance role.** You cannot choose the name. A different role on the instance means a different account name, and each input that holds the old name stops with `No AWS account named`. Edit each input, and give the new role the `sts:AssumeRole` statement and a place in the trust policy.
- **Every heavy forwarder that runs the input needs the role.** The account comes from that host's own metadata service. One role shared by the heavy forwarders is the simple way. Several roles mean several account names, and each role needs its own statement and its own place in the trust policy. If you used the template, add the other roles to the trust policy by hand, and add them again after any stack update that changes the trust policy, because that update removes them.
- **Do not delete and recreate either role.** AWS ties an ARN in a policy to the role's internal ID when the policy is saved. A new role with the same name has a new ID, so the old grant no longer matches: the policy then shows an ID starting `AROA` where the ARN was, and its owner must put the ARN back in place of that ID and save the policy. For `splunk-logserv-ta-role`, that owner is SAP, for its bucket, queue and key policies, and Splunk looks right while AWS answers `AccessDenied`. For the instance role, you fix the trust policy yourself. AWS documents this for role principals in trust policies and in other resource-based policies, S3 bucket policies among them. Update roles in place, keep the stack if you used the template, with termination protection on, because deleting it deletes the role, and check that your infrastructure code does not replace them.
- **Expect the input to restart when the credentials rotate.** The input watches its account's settings, and for this account they include the temporary credentials. When the metadata service rotates them, the input stops taking new messages, exits, and starts again with the new credentials. A stored key does not do this. The add-on ships **AWS SQS-Based S3** logging at `INFO`, so a rotation can be seen at the default level as the line `Content has been modified.`, with the account's name at the end of its `path`. Going by the add-on's code, the input exits about 10 seconds after that line, or about 5 minutes later if a file is still being read 10 seconds after the line. In our lab that line appeared 25 times in about 27 hours, mostly 56 to 65 minutes apart. Each time, the input exited about 10 seconds after the line and started again, usually within seconds and at most 3.6 minutes later (an idle input waits for its next interval). One line came while the input was reading a backlog: it started again 3 seconds after it exited and was reading again 9 seconds after that, so reading paused for 24 seconds, and no file was cut off or read twice. The lab's objects were small, about 0.5 KB each, and none was still being read 10 seconds after the line. Notifications wait in SAP's queue during the pause. Leave the log level as it is: changing it restarts every SQS-Based S3 input on the host (read in its code, not run).
- **Keep `[assume_role] duration` at 3600 or below.** The setting is in the add-on's `aws_settings.conf`, it defaults to 3600 and the form does not show it. AWS limits a session to one hour when one role assumes another. AWS's wording is not clear for an instance role, so treat it as limited. The add-on renews the session when less than 10 minutes remain. In our lab each input process assumed the role once when it started and ended within the hour, the longest after about 32 minutes, so this renewal was not exercised.
- **No `sts:ExternalId`.** The add-on sends none, so a trust policy that requires one blocks it. The add-on uses the fixed session name `splunk_ta_aws` on every heavy forwarder, so a condition on the session name must allow it, and the session name cannot tell your forwarders apart.
- **There is no key to rotate.** [Rotate the Access Key](aws-remote-s3-connect-guide.md#rotate-the-access-key) in the main guide does not apply.

<br>

### :material-circle-box:{ .taiconcolor } Troubleshooting

| What you see | What it means | What to do |
|---|---|---|
| The account is not listed under **Configuration > Account** | No instance profile, or the Splunk user cannot reach the metadata service (firewall, proxy, hop limit in a container, `AWS_EC2_METADATA_DISABLED`), or the host is a Splunk Cloud instance. The add-on logs this at debug level only | Run the check in [What the Host Must Allow](#what-the-host-must-allow) as the Splunk user, and fix what it shows. On a Splunk Cloud instance, use the IAM User path |
| Saving the input says `The SQS Queue entered may not be present in the given region.` | The message is misleading. The form shows it for any failure of its queue check: a trust policy that does not name the instance role, a missing `sts:AssumeRole` statement on an instance role in another account, SAP's queue policy not yet applied, or a wrong Region or URL | Run [7. Test Access](#7-test-access). Its errors name the failing call |
| The **SQS Queue Name** dropdown is empty or shows an error | Expected. It cannot list another account's queue, and the role does not hold `sqs:ListQueues` | Type the URL (step 8.c) |
| Saving the input says `Enabling dead letter queue is required for the SQS queue in this input.` | **Force using DLQ** is checked and SAP's queue has no redrive policy | Ask SAP to add one. Unchecking the box is the fallback, and it also skips the visibility check below |
| Saving the input says `It is recommended to set VisibilityTimeout larger than 5 minutes for specified SQS queue.` | This blocks the save, despite its wording: the queue's visibility timeout is under 300 seconds and **Force using DLQ** is checked | Ask SAP to raise it. Unchecking the box is the fallback |
| The input logs `Dead letter queue not found.` and stops | The same redrive check, when the input starts | As above |
| The input logs `No AWS account named` and `Data input was interrupted by an unhandled exception.` | The account the input names is gone: the role on the instance changed, or the instance can no longer reach the metadata service | Restore the role or the metadata access. If the role really changed, edit each input to the new account name and add the role to the trust policy |
| The input logs `Retrieve ec2 instance credentials failed.` | The metadata service gave the input no credentials | [What the Host Must Allow](#what-the-host-must-allow) |
| The input logs `Failed to download file.`, then `An error occurred while processing the message.` with `AccessDenied` in its traceback | The S3 or KMS side: your role's policy, SAP's bucket policy, or a key policy | **Disable the input at once.** Each failed message stays in the queue and comes back with a higher receive count, and if SAP's queue has a redrive policy, the backlog could move to SAP's dead-letter queue within a few cycles. Then run [7. Test Access](#7-test-access) and fix the cause before you enable the input |
| The input logs `Failed to delete message.` | Your role or SAP's queue policy does not allow `sqs:DeleteMessage`. The events were already indexed, and the message comes back | **Disable the input at once**, because each redelivery indexes the file again. Fix the policy before you enable it |
| The input logs `Data input was interrupted by an unhandled exception.` with `AccessDenied` in its traceback | The call named there was denied: `AssumeRole` is the trust policy, or the instance role's statement when that role is in another account; `ReceiveMessage` or `GetQueueAttributes` is your role's policy, SAP's queue policy or a key on the queue | Run [7. Test Access](#7-test-access), and fix what it shows |
| `AccessDenied` though the statements on this page are right | An SCP or RCP in your organization or SAP's, a permissions boundary on either role, or a VPC endpoint policy on the path to STS, SQS or S3. On SAP's side: an object that another account owns (Object Ownership), the AWS managed key `aws/s3` or `aws/sqs`, Requester Pays on the bucket, or a SAP policy that shows an ID starting `AROA` because `splunk-logserv-ta-role` was deleted and created again | Ask your cloud team, and SAP for the causes on its side. The error message usually names the kind of policy that denied the call |
| Creating an AWS S3 Direct input logs `Error while getting region for bucket` | Expected. The add-on asks for the bucket's Region, and neither your role's policy nor SAP's example allows `s3:GetBucketLocation`. The input keeps the Region from the form. Read in the code, not run | Nothing, unless objects fail with a Region error |

The other causes in step 8.d of the [main guide](aws-remote-s3-connect-guide.md#8-confirm-logserv-logs-are-being-ingested) apply too, except the access key.

<br>

### :material-circle-box:{ .taiconcolor } Hardening for Your Security Review

:material-lightning-bolt:{ .taiconcolor } **Any process on the host can fetch the role's credentials from the metadata service.** A stored key is harder to reach: the Splunk user or root can decrypt it, and the add-on's REST interface can return it to a signed-in Splunk user (read in its code, not run). Against that, there is no long-lived key: the credentials are temporary and rotate by themselves. Use the list below to narrow the difference.

- **Use the role only on the heavy forwarders.** Any instance that holds it reaches SAP's data.
- **Require IMDSv2** on these instances (<a href="https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/configuring-instance-metadata-options.html" target="_blank">AWS: configure the instance metadata options</a>).
- **Limit metadata access to the Splunk user with a firewall rule** (<a href="https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/instance-metadata-limiting-access.html" target="_blank">AWS: limit instance metadata access</a>), and make the rule persistent. Other apps that run as the Splunk user still share the access, and agents on the host that use the metadata service, such as the Systems Manager agent, lose it. For example:

```bash
sudo iptables --append OUTPUT --proto tcp --destination 169.254.169.254 \
  --match owner ! --uid-owner splunk --jump REJECT
```

- **Limit who can pass the role.** Anyone who can attach it to an instance they control can use it. Scope `iam:PassRole`, `ec2:AssociateIamInstanceProfile` and `ec2:ReplaceIamInstanceProfileAssociation` for this role (<a href="https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/permission-to-pass-iam-roles.html" target="_blank">AWS: permission to pass a role</a>).
- **Review who can run commands on the heavy forwarders,** through a shell or Systems Manager. They can use the role too.
- **Limit who can sign in to Splunk on the heavy forwarders.** The add-on's REST interface can return an account's credentials, including the role's temporary ones, to a signed-in user (read in its code, not run).

<br>

## :material-circle-box:{ .cboxmove } Next Steps

1. [Verify Your Data](../getting-started/verify-data.md).
2. Load the history you need with [AWS S3 Direct](aws-s3-direct.md): select the account named after the instance role and the IAM Role from step 6. Going by the Data TA's code, its checks pass with a role selected. Our lab has not run AWS S3 Direct with an instance role.
3. [Install the LogServ App](../logserv-app/installation.md) and seed its dashboards.
