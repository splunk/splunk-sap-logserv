# AWS Remote S3 Connect with an EC2 Instance Role

### :material-circle-box:{ .taiconcolor } Introduction

Use this page when your heavy forwarders run on Amazon EC2 and you may not create IAM users or long-lived access keys. It sets up the same scenario as the [AWS Remote S3 Connect Setup Guide](aws-remote-s3-connect-guide.md), without the IAM user: the Splunk Add-on for AWS takes temporary credentials from the heavy forwarder's EC2 instance profile, and no access key is created in AWS or stored in Splunk.

As in the main guide, the **_SAP ECS account_** holds SAP's S3 bucket and SQS queue, and the **_Secondary account_** is your own AWS account.

```text
Secondary account                              SAP ECS account
+---------------------------------------+      +----------------------------+
|  Heavy forwarder (EC2 instance)       |      |                            |
|    instance profile role              |      |  SQS queue and S3 bucket   |
|         |                             |      |                            |
|         | sts:AssumeRole              |      |  The queue access policy   |
|         v                             |      |  and the bucket policy     |
|  IAM role splunk-logserv-ta-role  ---------->|  name this IAM role        |
|    reads the queue and the bucket     |      |                            |
+---------------------------------------+      +----------------------------+
```

This page uses two IAM roles, and names them the same way throughout:

| Name on this page | What it is |
|---|---|
| **Instance profile role** | The IAM role in the instance profile attached to each heavy forwarder EC2 instance. It needs only `sts:AssumeRole` on the role below |
| **`splunk-logserv-ta-role`** | The IAM role in your **_Secondary account_** that holds the permissions on SAP's SQS queue and S3 bucket. SAP names its ARN in the SQS queue access policy and the S3 bucket policy |

This page does not apply when the input runs on a Splunk Cloud instance, on a host outside EC2, or on an EC2 instance that cannot have an instance profile: use the IAM user in the [main guide](aws-remote-s3-connect-guide.md) there. The **Filter** and **Copy** scenarios still need the IAM user.

<br>

### :material-circle-box:{ .taiconcolor } Before You Begin

- **Splunk Add-on for AWS 8.2.2 or later,** installed directly on each heavy forwarder ([Install the Splunk Add-on for AWS](aws-remote-s3-connect-guide.md#install-the-splunk-add-on-for-aws)).
- **[Check These First](aws-remote-s3-connect-guide.md#check-these-first)** in the main guide applies here too: the prerequisites, the Data TA, cloud attribution, filtering and the first start.
- **IAM permissions for you:** create and edit IAM roles and policies in the **_Secondary account_**; for scenario A also create a CloudFormation stack; and if a heavy forwarder has no instance profile yet, `iam:CreateInstanceProfile`, `iam:AddRoleToInstanceProfile`, `iam:PassRole` and `ec2:AssociateIamInstanceProfile`.
- **Each heavy forwarder can reach the instance metadata service** (`169.254.169.254`) as the Splunk user. [Heavy Forwarder Requirements](aws-remote-s3-connect-instance-role-reference.md#heavy-forwarder-requirements) has the full list and a check.

<br>

### :material-circle-box:{ .taiconcolor } Find Your Scenario

Look in the IAM console and the CloudFormation console of your **_Secondary account_**, and pick the first row that matches. The scenario decides only step 3; every other step is the same for all three.

| What your Secondary account has today | Your scenario |
|---|---|
| The CloudFormation stack from the standard Remote S3 Connect template (`splunk-logserv-remote-s3-connect.yaml`). It created the IAM user `splunk_logserv_user` and the IAM role `splunk-logserv-ta-role`, and your inputs use that user's access key | [**Scenario B:** switch the deployed stack's IAM role to the instance profile](#scenario-b) |
| An IAM role you want to reuse or must create yourself, without CloudFormation: a `splunk-logserv-ta-role` made by hand or by your own tooling, a role with another name, or a customer managed policy you want to attach | [**Scenario C:** create or reuse the IAM role and policy by hand](#scenario-c) |
| Nothing for LogServ yet: no IAM role named `splunk-logserv-ta-role` and no Remote S3 Connect stack | [**Scenario A:** deploy the instance-role CloudFormation template](#scenario-a) |

:material-lightning-bolt:{ .taiconcolor } If the account has a **Remote S3 Filter** or **Remote S3 Copy** stack, this page does not apply. Never update one of those stacks with the template on this page.

<br>

### :material-circle-box:{ .taiconcolor } Steps at a Glance { #high-level-steps }

| Step | Scenario A | Scenario B | Scenario C | Where |
|---|---|---|---|---|
| [1. Get SAP's ARNs](#1-get-saps-arns) | Yes | You have them | Yes | SAP LogServ Support |
| [2. Find or create the instance profile role](#2-find-or-create-the-instance-profile-role) | Yes | Yes | Yes | AWS, Secondary account |
| [3. Set up `splunk-logserv-ta-role`](#3-set-up-the-iam-role-splunk-logserv-ta-role) | [Deploy the stack](#scenario-a) | [Edit the trust policy](#scenario-b) | [Create or reuse by hand](#scenario-c) | AWS, Secondary account |
| [4. Give SAP the IAM role ARN](#4-give-sap-the-iam-role-arn) | Yes | Skip | Yes | SAP LogServ Support |
| [5. Confirm the account in the add-on](#5-confirm-the-account-in-the-add-on) | Yes | Yes | Yes | Splunk Web, each heavy forwarder |
| [6. Add the IAM role in the add-on](#6-add-the-iam-role-in-the-add-on) | Yes | Already there | Yes | Splunk Web, each heavy forwarder |
| [7. Test access](#7-test-access) | Yes | Yes | Yes | A shell on each heavy forwarder |
| [8. Create or switch the SQS-Based S3 input](#8-create-or-switch-the-sqs-based-s3-input) | Create | Switch | Create | Splunk Web, each heavy forwarder |
| [9. Confirm ingestion](#9-confirm-logserv-logs-are-being-ingested) | Yes | Yes | Yes | A search head |

Configure each heavy forwarder directly, not through a Deployment Server. Several heavy forwarders can read the same SQS queue ([Add Heavy Forwarders on the Same Queue](../getting-started/capacity-planning.md#add-heavy-forwarders-on-the-same-queue)): attach the same instance profile to each.

<br>

### :material-circle-box:{ .taiconcolor } 1. Get SAP's ARNs

1.<b class="taiconcolor">a</b> Obtain the ARN of the S3 bucket, the ARN of the SQS queue and their AWS Region, as in [1. Obtain ARNs from SAP ECS Account](aws-remote-s3-connect-guide.md#1-obtain-arns-from-sap-ecs-account) in the main guide.

1.<b class="taiconcolor">b</b> In your **_Secondary account_**, check under **Account > AWS Regions** that this Region is enabled.

1.<b class="taiconcolor">c</b> Ask SAP whether the bucket or the queue is encrypted with a customer managed KMS key. If so, see [Customer Managed KMS Keys](aws-remote-s3-connect-instance-role-reference.md#customer-managed-kms-keys) before step 3.

<br>

### :material-circle-box:{ .taiconcolor } 2. Find or Create the Instance Profile Role

An EC2 instance has one instance profile, and an instance profile holds one IAM role. Do the part that matches each heavy forwarder.

:material-lightning-bolt:{ .taiconcolor } The instance profile role and `splunk-logserv-ta-role` are two different IAM roles. Do not attach `splunk-logserv-ta-role` (or the role whose ARN you give SAP in step 4) to the heavy forwarder instance: the input would then ask that role to assume itself, and AWS refuses that with `AccessDenied`. If the role you find or create in this step is the one that holds the queue and bucket permissions, see [Troubleshooting](#troubleshooting).

#### :material-crop-square:{ .taiconcolor } The Heavy Forwarder Already Has an Instance Profile

Reuse it. Nothing on it changes except one inline policy in step 3.

2.<b class="taiconcolor">a</b> In the EC2 console, select the heavy forwarder instance. On the **Security** tab, click the link under **IAM Role**. It opens the role in the IAM console.

2.<b class="taiconcolor">b</b> Copy the role's **ARN** and its **name**. The ARN looks like `arn:aws:iam::<secondary-account-id>:role/<instance-profile-role-name>`.

??? tip "AWS CLI"
    ```bash
    # The instance profile attached to the instance
    aws ec2 describe-instances --instance-ids <instance-id> \
      --query 'Reservations[].Instances[].IamInstanceProfile.Arn' --output text

    # The IAM role inside that instance profile
    aws iam get-instance-profile --instance-profile-name <instance-profile-name> \
      --query 'InstanceProfile.Roles[].[RoleName,Arn]' --output text
    ```

#### :material-crop-square:{ .taiconcolor } The Heavy Forwarder Has No Instance Profile

2.<b class="taiconcolor">c</b> In the IAM console, click **Roles**, then **Create role**. Choose **AWS service** as the trusted entity type and **EC2** as the use case. Add no permissions policies. Name the role, for example `splunk-logserv-hf-instance-role`, and create it. The console creates an instance profile with the same name.

2.<b class="taiconcolor">d</b> In the EC2 console, select the heavy forwarder instance, then **Actions > Security > Modify IAM role**, choose the new role and click **Update IAM role**. Repeat for each heavy forwarder, and add the instance profile to the launch template of any heavy forwarder you build later. Splunk should not need a restart.

2.<b class="taiconcolor">e</b> Copy the role's **ARN** and **name** from its page in the IAM console.

??? tip "AWS CLI"
    Save this as `ec2-trust-policy.json`:

    ```json
    {
      "Version": "2012-10-17",
      "Statement": [
        {
          "Effect": "Allow",
          "Principal": { "Service": "ec2.amazonaws.com" },
          "Action": "sts:AssumeRole"
        }
      ]
    }
    ```

    ```bash
    aws iam create-role --role-name splunk-logserv-hf-instance-role \
      --assume-role-policy-document file://ec2-trust-policy.json
    aws iam create-instance-profile --instance-profile-name splunk-logserv-hf-instance-role
    aws iam add-role-to-instance-profile --instance-profile-name splunk-logserv-hf-instance-role \
      --role-name splunk-logserv-hf-instance-role
    aws ec2 associate-iam-instance-profile --instance-id <instance-id> \
      --iam-instance-profile Name=splunk-logserv-hf-instance-role
    ```

<br>

### :material-circle-box:{ .taiconcolor } 3. Set Up the IAM Role splunk-logserv-ta-role

Follow the one scenario you picked in [Find Your Scenario](#find-your-scenario), then go on to step 4.

<br>

#### :material-crop-square:{ .taiconcolor } Scenario A: Deploy the Instance-Role CloudFormation Template { #scenario-a }

The <a href="https://github.com/splunk/splunk-sap-logserv/blob/main/aws_assets/cloud_formation/splunk-logserv-remote-s3-connect-instance-role.yaml" target="_blank">CloudFormation template `splunk-logserv-remote-s3-connect-instance-role.yaml`</a> creates the IAM role `splunk-logserv-ta-role` with its trust policy and its inline policy, and adds the `sts:AssumeRole` inline policy to your instance profile role. It creates no IAM user and no access key.

??? tip "What does the CloudFormation template do?"
    Creates the following resources in your **_Secondary account_**:

    - An IAM Role named **_splunk-logserv-ta-role_**
    - A trust policy on that IAM Role that lets one principal assume it: the instance profile role you enter in **HeavyForwarderInstanceRoleArn**
    - An Inline IAM Policy named **_splunk-logserv-ta-policy_** on that IAM Role. It allows reading and deleting messages on SAP's SQS queue (`sqs:ReceiveMessage`, `sqs:DeleteMessage`, `sqs:ChangeMessageVisibility`, `sqs:GetQueueAttributes`), reading objects in SAP's S3 bucket (`s3:GetObject`, `s3:GetObjectVersion`) and listing that bucket (`s3:ListBucket`)
    - Only if you fill in **SapKmsKeyArns**: a `kms:Decrypt` statement in that policy, on the KMS keys you list

    Updates one resource that already exists:

    - Only if you fill in **HeavyForwarderInstanceRoleName**: it adds an Inline IAM Policy named **_splunk-logserv-sqs-based-input-assume-role-policy_** to your instance profile role. It allows `sts:AssumeRole` on **_splunk-logserv-ta-role_** and nothing else. The role's other policies and its trust policy are not changed

    Returns three stack outputs: **SplunkLogServRoleArn** (the ARN for steps 4 and 6), **InstanceRoleGrant** (whether the stack added the policy to your instance profile role) and **YourAccountId**.

    It creates no IAM User, no access key, no instance profile, no S3 Bucket and no SQS Queue, and it changes nothing in the **_SAP ECS account_**. Deleting the stack deletes the IAM Role and removes the inline policy from your instance profile role.

A.<b class="taiconcolor">1</b> In the CloudFormation console of your **_Secondary account_**, in the Region of SAP's queue, click **Create stack**, then **With new resources (standard)**. Upload the template file and click **Next**.

A.<b class="taiconcolor">2</b> Name the stack, for example `splunk-logserv-remote-s3-connect-instance-role`, and enter the parameters:

| Parameter | Value |
|---|---|
| **CrossAccountSQSQueueArn** | The complete ARN of SAP's SQS queue |
| **CrossAccountS3Bucket** | The name (not the ARN) of SAP's S3 bucket |
| **SapKmsKeyArns** | Blank, unless SAP uses customer managed KMS keys. Then their ARNs, separated by commas with no spaces |
| **HeavyForwarderInstanceRoleArn** | The ARN of the instance profile role from step 2 |
| **HeavyForwarderInstanceRoleName** | The name of that same role, without any path. Leave it blank only if that role is in another AWS account, then do [C.3](#c3-allow-the-instance-profile-role-to-assume-the-iam-role) in that account |

A.<b class="taiconcolor">3</b> Click **Next**, check **I acknowledge that AWS CloudFormation might create IAM resources with custom names**, click **Next**, then **Submit**. Wait for `CREATE_COMPLETE`.

A.<b class="taiconcolor">4</b> On the stack's **Outputs** tab, copy **SplunkLogServRoleArn**. It is the ARN for steps 4 and 6.

A.<b class="taiconcolor">5</b> Turn on termination protection (**Stack actions > Edit termination protection**). Deleting the stack deletes the IAM role, and SAP's policies stop matching it ([Do Not Delete and Recreate the IAM Roles](aws-remote-s3-connect-instance-role-reference.md#do-not-delete-and-recreate-the-iam-roles)).

??? tip "AWS CLI"
    ```bash
    aws cloudformation deploy \
      --region <region-of-the-sap-queue> \
      --stack-name splunk-logserv-remote-s3-connect-instance-role \
      --template-file splunk-logserv-remote-s3-connect-instance-role.yaml \
      --capabilities CAPABILITY_NAMED_IAM \
      --parameter-overrides \
        CrossAccountSQSQueueArn=arn:aws:sqs:<region>:<sap-ecs-account-id>:<queue-name> \
        CrossAccountS3Bucket=<bucket-name> \
        HeavyForwarderInstanceRoleArn=arn:aws:iam::<secondary-account-id>:role/<instance-profile-role-name> \
        HeavyForwarderInstanceRoleName=<instance-profile-role-name>

    aws cloudformation describe-stacks --region <region-of-the-sap-queue> \
      --stack-name splunk-logserv-remote-s3-connect-instance-role \
      --query 'Stacks[0].Outputs' --output table

    aws cloudformation update-termination-protection --enable-termination-protection \
      --region <region-of-the-sap-queue> \
      --stack-name splunk-logserv-remote-s3-connect-instance-role
    ```

Continue with [step 4](#4-give-sap-the-iam-role-arn).

<br>

#### :material-crop-square:{ .taiconcolor } Scenario B: Switch the Deployed Stack's IAM Role to the Instance Profile { #scenario-b }

Your stack already created `splunk-logserv-ta-role`, and SAP's SQS queue access policy and S3 bucket policy already name it. You add the instance profile role to that IAM role's trust policy, switch the inputs, then retire the IAM user's access key. The IAM role keeps its ARN, so SAP changes nothing, and the inputs keep working on the access key until you switch them.

:material-lightning-bolt:{ .taiconcolor } Leave the CloudFormation stack in place. Do not delete it: deleting it deletes the IAM role. Do not update it with a template that changes the IAM role either: CloudFormation would overwrite the trust policy you edit here. CloudFormation drift detection will report the trust policy you edit as modified, which is expected.

B.<b class="taiconcolor">1</b> In the IAM console, click **Roles**, open `splunk-logserv-ta-role`, click the **Trust relationships** tab, then **Edit trust policy**.

B.<b class="taiconcolor">2</b> Add the ARN of the instance profile role from step 2 to the `Principal`, next to the IAM user that is already there, and click **Update policy**:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "AWS": [
          "arn:aws:iam::<secondary-account-id>:user/splunk_logserv_user",
          "arn:aws:iam::<secondary-account-id>:role/<instance-profile-role-name>"
        ]
      },
      "Action": "sts:AssumeRole"
    }
  ]
}
```

??? tip "AWS CLI"
    ```bash
    # Show the trust policy in place, and save the edited document as trust-policy.json
    aws iam get-role --role-name splunk-logserv-ta-role \
      --query 'Role.AssumeRolePolicyDocument' --output json

    aws iam update-assume-role-policy --role-name splunk-logserv-ta-role \
      --policy-document file://trust-policy.json
    ```

B.<b class="taiconcolor">3</b> Do [C.3](#c3-allow-the-instance-profile-role-to-assume-the-iam-role): the inline policy that lets the instance profile role assume `splunk-logserv-ta-role`.

B.<b class="taiconcolor">4</b> Skip step 4, and do steps 5, 7, 8 and 9. In step 8 you switch your existing inputs, you do not create new ones.

B.<b class="taiconcolor">5</b> After step 9 shows data arriving through the instance profile on every heavy forwarder, retire the access key:

- In the Splunk Add-on for AWS on each heavy forwarder, under **Configuration > Account**, delete the account that holds the IAM user's access key.
- In the IAM console, open the user `splunk_logserv_user`, click the **Security credentials** tab, and under **Access keys** choose **Actions > Deactivate**, then **Delete**.
- Edit the trust policy of `splunk-logserv-ta-role` again and remove the IAM user's ARN, so that only the instance profile role remains.
- Leave the IAM user itself in place, without a key. The stack owns it.

??? tip "AWS CLI"
    ```bash
    aws iam list-access-keys --user-name splunk_logserv_user
    aws iam update-access-key --user-name splunk_logserv_user \
      --access-key-id <access-key-id> --status Inactive
    aws iam delete-access-key --user-name splunk_logserv_user --access-key-id <access-key-id>

    # trust-policy.json now names only the instance profile role
    aws iam update-assume-role-policy --role-name splunk-logserv-ta-role \
      --policy-document file://trust-policy.json
    ```

The permissions policy the standard stack put on the IAM role works as it is. To narrow it to what the input uses, see [What the Permissions Policy Leaves Out](aws-remote-s3-connect-instance-role-reference.md#what-the-permissions-policy-leaves-out).

Continue with [step 5](#5-confirm-the-account-in-the-add-on).

<br>

#### :material-crop-square:{ .taiconcolor } Scenario C: Create or Reuse the IAM Role and Policy by Hand { #scenario-c }

Three things must be true when you finish. Each sub-step shows how to get there with a new resource or with one you already have.

| | What must be true | Sub-step |
|---|---|---|
| 1 | The IAM role's **trust policy** lets the instance profile role assume it | [C.1](#c1-the-iam-role-and-its-trust-policy) |
| 2 | The IAM role has a **permissions policy** (inline or customer managed) that reads SAP's SQS queue and S3 bucket | [C.2](#c2-the-permissions-policy) |
| 3 | The instance profile role may call `sts:AssumeRole` on the IAM role | [C.3](#c3-allow-the-instance-profile-role-to-assume-the-iam-role) |

:material-lightning-bolt:{ .taiconcolor } **The role name.** SAP's example policies show the name `splunk-logserv-ta-role`, and this page uses it. If you reuse an IAM role with another name, use that name wherever this page says `splunk-logserv-ta-role`, and give SAP that role's ARN in step 4.

##### C.1 The IAM Role and Its Trust Policy { #c1-the-iam-role-and-its-trust-policy }

**To create a new IAM role:** in the IAM console, click **Roles**, then **Create role**, choose **Custom trust policy**, paste the document below with the ARN from step 2, click **Next**, add no permissions yet, name the role `splunk-logserv-ta-role` and create it.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "AWS": "arn:aws:iam::<secondary-account-id>:role/<instance-profile-role-name>"
      },
      "Action": "sts:AssumeRole"
    }
  ]
}
```

**To reuse an existing IAM role:** open the role, click the **Trust relationships** tab, then **Edit trust policy**. Keep the statements that are there, and add the statement above to the `Statement` list (or add the ARN to the `Principal` of a statement that already allows `sts:AssumeRole` with no conditions). Click **Update policy**.

Do not add an `sts:ExternalId` condition: the add-on sends none. A condition on the role session name must allow `splunk_ta_aws`.

??? tip "AWS CLI"
    Save the trust policy as `trust-policy.json`, then:

    ```bash
    # New IAM role
    aws iam create-role --role-name splunk-logserv-ta-role \
      --assume-role-policy-document file://trust-policy.json

    # Existing IAM role: read its trust policy, add the statement, write it back
    aws iam get-role --role-name <existing-role-name> \
      --query 'Role.AssumeRolePolicyDocument' --output json
    aws iam update-assume-role-policy --role-name <existing-role-name> \
      --policy-document file://trust-policy.json
    ```

##### C.2 The Permissions Policy { #c2-the-permissions-policy }

The IAM role needs these permissions, on SAP's resources:

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

If SAP uses a customer managed KMS key, add the `kms:Decrypt` statement from [Customer Managed KMS Keys](aws-remote-s3-connect-instance-role-reference.md#customer-managed-kms-keys). `s3:ListBucket` is for [AWS S3 Direct](aws-s3-direct.md), which loads history; the SQS-Based S3 input does not use it.

Pick one way to give them to the role:

| You have | Do this in the IAM console |
|---|---|
| **A customer managed policy you want to reuse** | Open the policy and check on its **Permissions** tab that it allows every action above on SAP's queue ARN and bucket. If it does not, click **Edit** and add what is missing. Then open the IAM role, click **Add permissions > Attach policies**, select the policy and click **Add permissions** |
| **No policy, and you want a customer managed policy** (one policy you can attach to several roles and version) | Click **Policies**, then **Create policy**, choose **JSON**, paste the document above with SAP's values, name it `splunk-logserv-ta-policy` and create it. Then attach it to the IAM role as in the row above |
| **No policy, and an inline policy is enough** (what the CloudFormation template does) | Open the IAM role, click **Add permissions > Create inline policy**, choose **JSON**, paste the document above with SAP's values, and name it `splunk-logserv-ta-policy` |

??? tip "AWS CLI"
    Save the permissions document as `permissions-policy.json`, then use one of these:

    ```bash
    # Reuse a customer managed policy: read its default version, then attach it
    aws iam get-policy --policy-arn arn:aws:iam::<secondary-account-id>:policy/<policy-name> \
      --query 'Policy.DefaultVersionId' --output text
    aws iam get-policy-version \
      --policy-arn arn:aws:iam::<secondary-account-id>:policy/<policy-name> \
      --version-id <version-id> --query 'PolicyVersion.Document' --output json
    aws iam attach-role-policy --role-name splunk-logserv-ta-role \
      --policy-arn arn:aws:iam::<secondary-account-id>:policy/<policy-name>

    # Add missing permissions to that policy: a new default version
    aws iam create-policy-version \
      --policy-arn arn:aws:iam::<secondary-account-id>:policy/<policy-name> \
      --policy-document file://permissions-policy.json --set-as-default

    # Create a new customer managed policy, then attach it
    aws iam create-policy --policy-name splunk-logserv-ta-policy \
      --policy-document file://permissions-policy.json
    aws iam attach-role-policy --role-name splunk-logserv-ta-role \
      --policy-arn arn:aws:iam::<secondary-account-id>:policy/splunk-logserv-ta-policy

    # Or an inline policy on the IAM role
    aws iam put-role-policy --role-name splunk-logserv-ta-role \
      --policy-name splunk-logserv-ta-policy --policy-document file://permissions-policy.json
    ```

##### C.3 Allow the Instance Profile Role to Assume the IAM Role { #c3-allow-the-instance-profile-role-to-assume-the-iam-role }

Open the **instance profile role** from step 2 in the IAM console, click **Add permissions > Create inline policy**, choose **JSON**, paste this with the ARN of `splunk-logserv-ta-role`, and name it `splunk-logserv-sqs-based-input-assume-role-policy`:

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

If you manage the instance profile role's permissions in a customer managed policy of your own, add this statement to that policy instead.

AWS requires this statement when the instance profile role is in a different AWS account from `splunk-logserv-ta-role`; add it in that account. In the same account the trust policy alone is enough, and the statement records what the instance profile role may assume.

??? tip "AWS CLI"
    Save the document as `assume-role-policy.json`, then:

    ```bash
    aws iam put-role-policy --role-name <instance-profile-role-name> \
      --policy-name splunk-logserv-sqs-based-input-assume-role-policy \
      --policy-document file://assume-role-policy.json
    ```

Continue with [step 4](#4-give-sap-the-iam-role-arn), or with step B.4 if you came here from scenario B.

<br>

### :material-circle-box:{ .taiconcolor } 4. Give SAP the IAM Role ARN

Scenario B: skip this step. SAP's policies already name the IAM role.

4.<b class="taiconcolor">a</b> Copy the ARN of `splunk-logserv-ta-role` from its page in the IAM console (scenario A: the stack output **SplunkLogServRoleArn**). It looks like `arn:aws:iam::<secondary-account-id>:role/splunk-logserv-ta-role`. Do not send the ARN of the instance profile or of the instance profile role.

4.<b class="taiconcolor">b</b> Ask SAP LogServ Support to add that ARN to the <a href="https://github.com/splunk/splunk-sap-logserv/blob/main/aws_assets/sap_ecs_account_policies/sap-ecs-account-sqs-access-policy.json" target="_blank">SQS queue access policy</a> and the <a href="https://github.com/splunk/splunk-sap-logserv/blob/main/aws_assets/sap_ecs_account_policies/sap-ecs-account-s3-access-policy.json" target="_blank">S3 bucket policy</a>, keeping `s3:ListBucket` on the bucket as the example does. [What to Ask SAP](aws-remote-s3-connect-instance-role-reference.md#what-to-ask-sap) lists what else to confirm in the same request.

:material-lightning-bolt:{ .taiconcolor } **Wait until SAP LogServ Support confirms that both policies are applied** before step 7. Steps 5 and 6 can be done in the meantime.

<br>

### :material-circle-box:{ .taiconcolor } 5. Confirm the Account in the Add-on

Do steps 5 to 8 on each heavy forwarder that will run the input.

5.<b class="taiconcolor">a</b> Log in to Splunk Web on the heavy forwarder with a Splunk admin role, open the **Splunk Add-on for AWS**, then click **Configuration**, then **Account**.

5.<b class="taiconcolor">b</b> Look for a row named after the instance profile role, with **Yes** in the **Autodiscovered IAM Role** column. You do not add this account, and no key is stored. If the row is missing, see [Troubleshooting](#troubleshooting).

<br>

### :material-circle-box:{ .taiconcolor } 6. Add the IAM Role in the Add-on

Scenario B: skip this step. The add-on already has the IAM role.

6.<b class="taiconcolor">a</b> Click the **IAM Role** tab, then **Add**.

6.<b class="taiconcolor">b</b> Enter a name that uses only letters, digits and underscores, for example `splunk_logserv_ta_role`, and the ARN of `splunk-logserv-ta-role` in **IAM Role ARN**, then click **Add**. Step 6 of the [main guide](aws-remote-s3-connect-guide.md#6-configure-iam-role-aws-add-on) has screenshots of this form.

<br>

### :material-circle-box:{ .taiconcolor } 7. Test Access

When you save an input, the add-on checks only the SQS queue. A missing S3 or KMS permission shows up only after the input has started taking messages. So test both from the heavy forwarder first: follow [Test Access from the Heavy Forwarder](aws-remote-s3-connect-instance-role-reference.md#test-access-from-the-heavy-forwarder). It needs AWS CLI v2 on the heavy forwarder, only reads, and takes a few minutes.

<br>

### :material-circle-box:{ .taiconcolor } 8. Create or Switch the SQS-Based S3 Input

#### :material-crop-square:{ .taiconcolor } Scenarios A and C: Create the Input

:material-lightning-bolt:{ .taiconcolor } The input starts with every notification already waiting in SAP's SQS queue, up to 14 days of them. Read [First Start: The Queue Backlog](../getting-started/capacity-planning.md#first-start-the-queue-backlog) before you add it.

8.<b class="taiconcolor">a</b> Click the **Inputs** tab, then **Create New Input**, **Custom Data Type**, then **SQS-Based S3 (Recommended)**. Step 7 of the [main guide](aws-remote-s3-connect-guide.md#7-configure-sqs-based-s3-input-aws-add-on) has screenshots of this form.

8.<b class="taiconcolor">b</b> Fill in the form:

| Field | Value |
|---|---|
| **Name** | A descriptive name |
| **AWS Account** | The account named after the instance profile role (step 5) |
| **Assume Role** | The IAM role from step 6. It must not be the same role as the one in **AWS Account** |
| **Force using DLQ (Recommended)** | Checked |
| **AWS Region** | The Region of SAP's queue |
| **Use Private Endpoints** | Unchecked |
| **SQS Queue Name** | Type the queue **URL** and select it as **(New value)**: `https://sqs.<region>.amazonaws.com/<sap-ecs-account-id>/<queue-name>`. The dropdown cannot list a queue in another AWS account |
| **SQS Batch Size** | 10 |
| **S3 File Decoder** | Custom Logs |
| **Signature Validate All Events** | **Unchecked** |
| **Source Type** | `sap_logserv_logs` |
| **Index** | `sap_logserv_logs`, or the name you gave the LogServ data index |

8.<b class="taiconcolor">c</b> Click **Add**, then disable the new input on the **Inputs** tab straight away.

8.<b class="taiconcolor">d</b> Add the cloud attribution. In `$SPLUNK_HOME/etc/apps/Splunk_TA_aws/local/inputs.conf`, add this line to the input's stanza, `[aws_sqs_based_s3://<input name>]`:

```ini
_meta = cloud_provider::aws
```

8.<b class="taiconcolor">e</b> Restart Splunk, then enable the input. [Add the `_meta` Line to an AWS Input](cloud-attribution.md#add-the-meta-line-to-an-aws-input) shows how to write the line over REST with no restart.

#### :material-crop-square:{ .taiconcolor } Scenario B: Switch Your Existing Inputs

8.<b class="taiconcolor">f</b> On the **Inputs** tab, edit each SQS-Based S3 input that uses the IAM user's account. Change **AWS Account** to the account named after the instance profile role (step 5), leave **Assume Role** and every other field as they are, and save the input.

8.<b class="taiconcolor">g</b> Check that the `_meta = cloud_provider::aws` line is still in each input's stanza in `$SPLUNK_HOME/etc/apps/Splunk_TA_aws/local/inputs.conf`. Put it back if the edit removed it (step 8.d).

8.<b class="taiconcolor">h</b> After step 9, go back to [B.5](#scenario-b) and retire the access key.

<br>

### :material-circle-box:{ .taiconcolor } 9. Confirm LogServ Logs are Being Ingested

Allow 5-10 minutes for the first events.

9.<b class="taiconcolor">a</b> On a search head that can search the LogServ data index, run:

    index=sap_logserv_logs earliest=-1h | stats count by sourcetype, host

You should see the sourcetypes your SAP LogServ subscription delivers, from several hosts. [Verify Your Data](../getting-started/verify-data.md) has the full set of checks.

9.<b class="taiconcolor">b</b> Check the add-on's logs even if events arrive, because a permission problem on some objects does not stop the others:

    index=_internal source=*aws* level IN (ERROR,WARNING) earliest=-1h | head 50

<br>

### :material-circle-box:{ .taiconcolor } Troubleshooting

| What you see | What to do |
|---|---|
| No autodiscovered account under **Configuration > Account** | The instance has no instance profile, or the Splunk user cannot reach the instance metadata service. Run the check in [Heavy Forwarder Requirements](aws-remote-s3-connect-instance-role-reference.md#heavy-forwarder-requirements) |
| Saving the input says `The SQS Queue entered may not be present in the given region.` | The add-on shows this for any failure of its queue check: the trust policy does not name the instance profile role, SAP's SQS queue access policy is not applied yet, or the Region or URL is wrong. Run [step 7](#7-test-access); its error names the failing call |
| Saving the input says `An error occurred (AccessDenied) when calling the AssumeRole operation: User: arn:aws:sts::<account-id>:assumed-role/<role-name>/<instance-id> is not authorized to perform: sts:AssumeRole on resource: arn:aws:iam::<account-id>:role/<role-name>`, with the **same role name** in both places | The role attached to the heavy forwarder instance is also the role selected in **Assume Role**, so it is asked to assume itself. Either attach a separate instance profile role to the instance (step 2) and let it assume this role (step 3), which is the setup this page describes; or, if the attached role already holds the permissions of [C.2](#c2-the-permissions-policy) and is the role SAP's policies name, edit the input and clear **Assume Role**. The second way has not been run in our lab |
| The **SQS Queue Name** dropdown is empty | Expected. Type the queue URL (step 8.b) |
| The input logs `AccessDenied` | **Disable the input at once,** so that failed messages do not pile up or move to SAP's dead-letter queue. Run [step 7](#7-test-access) and fix what it shows |
| The input logs `No AWS account named` | The instance profile on the instance changed. Restore it, or edit each input to the new account name and add the new instance profile role to the trust policy |

The [reference page](aws-remote-s3-connect-instance-role-reference.md#troubleshooting) has the full table.

<br>

## :material-circle-box:{ .cboxmove } Next Steps

1. [Verify Your Data](../getting-started/verify-data.md).
2. Load the history you need with [AWS S3 Direct](aws-s3-direct.md): select the account named after the instance profile role, and the IAM role from step 6.
3. [Install the LogServ App](../logserv-app/installation.md) and seed its dashboards.
4. Read [What Behaves Differently from a Stored Key](aws-remote-s3-connect-instance-role-reference.md#what-behaves-differently-from-a-stored-key) and [Hardening for Your Security Review](aws-remote-s3-connect-instance-role-reference.md#hardening-for-your-security-review).
