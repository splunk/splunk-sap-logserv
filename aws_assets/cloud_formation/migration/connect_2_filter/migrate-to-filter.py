#!/usr/bin/env python3
"""
Splunk LogServ Remote S3 Filter Migration Script

This script migrates an existing splunk-logserv-remote-s3-connect deployment
to the splunk-logserv-remote-s3-filter deployment by:
1. Updating the existing IAM Role to support Lambda execution
2. Creating local SQS queues for filtered notifications
3. Creating the Lambda filter function
4. Creating the Event Source Mapping

Prerequisites:
- Python 3.8+
- boto3 library (pip install boto3)
- AWS credentials configured (via environment variables, ~/.aws/credentials, or IAM role)
- Existing splunk-logserv-remote-s3-connect deployment
- Lambda code zip file already uploaded to S3
- Cross-account permissions already granted by SAP LogServ Support

Usage:
    python migrate-to-filter.py --config migration-config.json --region us-east-1
    python migrate-to-filter.py --config migration-config.json --region us-east-1 --dry-run
    python migrate-to-filter.py --config migration-config.json --region us-east-1 --profile my-aws-profile
"""

import argparse
import json
import sys
import os
import time
from datetime import datetime
from typing import Any

# Enable ANSI color support on Windows
if sys.platform == 'win32':
    os.system('')

try:
    import boto3
    from botocore.exceptions import ClientError, NoCredentialsError
except ImportError:
    print("ERROR: boto3 is required. Install it with: pip install boto3")
    sys.exit(1)


# ANSI color codes for terminal output
class Colors:
    HEADER = '\033[95m'
    BLUE = '\033[94m'
    CYAN = '\033[96m'
    GREEN = '\033[92m'
    YELLOW = '\033[93m'
    RED = '\033[91m'
    ENDC = '\033[0m'
    BOLD = '\033[1m'


def print_header(message: str) -> None:
    print(f"\n{Colors.HEADER}{Colors.BOLD}{'='*70}{Colors.ENDC}")
    print(f"{Colors.HEADER}{Colors.BOLD}{message}{Colors.ENDC}")
    print(f"{Colors.HEADER}{Colors.BOLD}{'='*70}{Colors.ENDC}")


def print_step(step_num: int, message: str) -> None:
    print(f"\n{Colors.CYAN}{Colors.BOLD}[Step {step_num}] {message}{Colors.ENDC}")


def print_info(message: str) -> None:
    print(f"{Colors.BLUE}  ℹ {message}{Colors.ENDC}")


def print_success(message: str) -> None:
    print(f"{Colors.GREEN}  ✓ {message}{Colors.ENDC}")


def print_warning(message: str) -> None:
    print(f"{Colors.YELLOW}  ⚠ {message}{Colors.ENDC}")


def print_error(message: str) -> None:
    print(f"{Colors.RED}  ✗ {message}{Colors.ENDC}")


def print_dry_run(message: str) -> None:
    print(f"{Colors.YELLOW}  [DRY-RUN] {message}{Colors.ENDC}")


def load_config(config_path: str) -> dict:
    """Load and validate configuration from JSON file."""
    try:
        with open(config_path, 'r') as f:
            config = json.load(f)
        return config
    except FileNotFoundError:
        print_error(f"Configuration file not found: {config_path}")
        sys.exit(1)
    except json.JSONDecodeError as e:
        print_error(f"Invalid JSON in configuration file: {e}")
        sys.exit(1)


def get_account_id(sts_client) -> str:
    """Get the current AWS account ID."""
    return sts_client.get_caller_identity()["Account"]


def validate_prerequisites(config: dict, region: str, profile: str, dry_run: bool) -> dict:
    """Validate that all prerequisites are met before migration."""
    print_step(1, "Validating prerequisites")
    
    clients = {}
    
    try:
        # Create session with optional profile
        if profile:
            session = boto3.Session(profile_name=profile, region_name=region)
            print_info(f"Using AWS profile: {profile}")
        else:
            session = boto3.Session(region_name=region)
        
        clients['iam'] = session.client('iam')
        clients['sqs'] = session.client('sqs')
        clients['lambda'] = session.client('lambda')
        clients['logs'] = session.client('logs')
        clients['s3'] = session.client('s3')
        clients['sts'] = session.client('sts')
    except NoCredentialsError:
        print_error("AWS credentials not found. Configure credentials and try again.")
        sys.exit(1)
    
    # Get account ID
    account_id = get_account_id(clients['sts'])
    print_info(f"AWS Account ID: {account_id}")
    print_info(f"AWS Region: {region}")
    
    # Validate existing IAM Role
    role_name = config['existing_resources']['iam_role_name']
    try:
        role_response = clients['iam'].get_role(RoleName=role_name)
        print_success(f"Existing IAM Role found: {role_name}")
    except ClientError as e:
        if e.response['Error']['Code'] == 'NoSuchEntity':
            print_error(f"IAM Role not found: {role_name}")
            sys.exit(1)
        raise
    
    # Validate existing IAM User
    user_arn = config['existing_resources']['iam_user_arn']
    user_name = user_arn.split('/')[-1]
    try:
        clients['iam'].get_user(UserName=user_name)
        print_success(f"Existing IAM User found: {user_name}")
    except ClientError as e:
        if e.response['Error']['Code'] == 'NoSuchEntity':
            print_error(f"IAM User not found: {user_name}")
            sys.exit(1)
        raise
    
    # Validate Lambda code exists in S3
    code_bucket = config['lambda_function']['code_s3_bucket']
    code_key = config['lambda_function']['code_s3_key']
    try:
        clients['s3'].head_object(Bucket=code_bucket, Key=code_key)
        print_success(f"Lambda code found: s3://{code_bucket}/{code_key}")
    except ClientError as e:
        if e.response['Error']['Code'] == '404':
            print_error(f"Lambda code not found: s3://{code_bucket}/{code_key}")
            sys.exit(1)
        elif e.response['Error']['Code'] == '403':
            print_error(f"Access denied to Lambda code: s3://{code_bucket}/{code_key}")
            sys.exit(1)
        raise
    
    # Check if local SQS queue already exists
    queue_name = config['local_sqs']['queue_name']
    try:
        clients['sqs'].get_queue_url(QueueName=queue_name)
        print_warning(f"Local SQS queue already exists: {queue_name}")
    except ClientError as e:
        if e.response['Error']['Code'] == 'AWS.SimpleQueueService.NonExistentQueue':
            print_info(f"Local SQS queue will be created: {queue_name}")
        else:
            raise
    
    # Check if Lambda function already exists
    function_name = config['lambda_function']['function_name']
    try:
        clients['lambda'].get_function(FunctionName=function_name)
        print_warning(f"Lambda function already exists: {function_name}")
    except ClientError as e:
        if e.response['Error']['Code'] == 'ResourceNotFoundException':
            print_info(f"Lambda function will be created: {function_name}")
        else:
            raise
    
    print_success("All prerequisites validated")
    
    return {
        'clients': clients,
        'account_id': account_id,
        'region': region
    }


def update_iam_role_trust_policy(config: dict, context: dict, dry_run: bool) -> None:
    """Update IAM Role trust policy to allow Lambda service."""
    print_step(2, "Updating IAM Role trust policy")
    
    iam = context['clients']['iam']
    role_name = config['existing_resources']['iam_role_name']
    user_arn = config['existing_resources']['iam_user_arn']
    
    # Get current trust policy
    role = iam.get_role(RoleName=role_name)
    current_policy = role['Role']['AssumeRolePolicyDocument']
    
    # Check if Lambda is already trusted
    lambda_trusted = False
    for statement in current_policy.get('Statement', []):
        principal = statement.get('Principal', {})
        if isinstance(principal, dict):
            service = principal.get('Service', '')
            if service == 'lambda.amazonaws.com' or (isinstance(service, list) and 'lambda.amazonaws.com' in service):
                lambda_trusted = True
                break
    
    if lambda_trusted:
        print_info("Lambda service is already trusted by the role")
        return
    
    # Create new trust policy
    new_trust_policy = {
        "Version": "2012-10-17",
        "Statement": [
            {
                "Effect": "Allow",
                "Principal": {
                    "AWS": user_arn,
                    "Service": "lambda.amazonaws.com"
                },
                "Action": "sts:AssumeRole"
            }
        ]
    }
    
    if dry_run:
        print_dry_run(f"Would update trust policy for role: {role_name}")
        print_dry_run(f"New trust policy: {json.dumps(new_trust_policy, indent=2)}")
        return
    
    iam.update_assume_role_policy(
        RoleName=role_name,
        PolicyDocument=json.dumps(new_trust_policy)
    )
    print_success(f"Updated trust policy to include lambda.amazonaws.com")


def attach_lambda_execution_policy(config: dict, context: dict, dry_run: bool) -> None:
    """Attach AWSLambdaBasicExecutionRole managed policy to the role."""
    print_step(3, "Attaching Lambda execution managed policy")
    
    iam = context['clients']['iam']
    role_name = config['existing_resources']['iam_role_name']
    policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
    
    # Check if policy is already attached
    attached_policies = iam.list_attached_role_policies(RoleName=role_name)
    for policy in attached_policies['AttachedPolicies']:
        if policy['PolicyArn'] == policy_arn:
            print_info("AWSLambdaBasicExecutionRole is already attached")
            return
    
    if dry_run:
        print_dry_run(f"Would attach policy: {policy_arn}")
        return
    
    iam.attach_role_policy(
        RoleName=role_name,
        PolicyArn=policy_arn
    )
    print_success("Attached AWSLambdaBasicExecutionRole managed policy")


def update_cloudwatch_logs_permissions(config: dict, context: dict, dry_run: bool) -> None:
    """Add CloudWatch Logs permissions to the existing inline policy."""
    print_step(4, "Adding CloudWatch Logs permissions")
    
    iam = context['clients']['iam']
    role_name = config['existing_resources']['iam_role_name']
    account_id = context['account_id']
    region = context['region']
    policy_name = config['existing_resources']['iam_role_policy_name']
    
    # Get current inline policy
    try:
        policy_response = iam.get_role_policy(RoleName=role_name, PolicyName=policy_name)
        current_policy = policy_response['PolicyDocument']
    except ClientError as e:
        if e.response['Error']['Code'] == 'NoSuchEntity':
            print_warning(f"Inline policy '{policy_name}' not found, will create new policy")
            current_policy = {"Version": "2012-10-17", "Statement": []}
        else:
            raise
    
    # Check if CloudWatch Logs permission already exists
    logs_resource = f"arn:aws:logs:{region}:{account_id}:log-group:/aws/lambda/*"
    has_logs_permission = False
    
    for statement in current_policy.get('Statement', []):
        resources = statement.get('Resource', [])
        if isinstance(resources, str):
            resources = [resources]
        if logs_resource in resources or f"arn:aws:logs:{region}:{account_id}:*" in resources:
            actions = statement.get('Action', [])
            if isinstance(actions, str):
                actions = [actions]
            if 'logs:PutLogEvents' in actions or 'logs:*' in actions:
                has_logs_permission = True
                break
    
    if has_logs_permission:
        print_info("CloudWatch Logs permissions already exist")
        return
    
    # Add CloudWatch Logs statement
    logs_statement = {
        "Sid": "LambdaCloudWatchLogsAccess",
        "Effect": "Allow",
        "Action": [
            "logs:CreateLogGroup",
            "logs:CreateLogStream",
            "logs:PutLogEvents"
        ],
        "Resource": logs_resource
    }
    
    current_policy['Statement'].append(logs_statement)
    
    if dry_run:
        print_dry_run(f"Would add CloudWatch Logs statement to policy: {policy_name}")
        return
    
    iam.put_role_policy(
        RoleName=role_name,
        PolicyName=policy_name,
        PolicyDocument=json.dumps(current_policy)
    )
    print_success("Added CloudWatch Logs permissions to inline policy")


def create_dead_letter_queue(config: dict, context: dict, dry_run: bool) -> str:
    """Create the Dead Letter Queue for failed messages."""
    print_step(5, "Creating Dead Letter Queue")
    
    sqs = context['clients']['sqs']
    queue_name = config['local_sqs']['queue_name'] + "-dlq"
    account_id = context['account_id']
    region = context['region']
    
    # Check if DLQ already exists
    try:
        response = sqs.get_queue_url(QueueName=queue_name)
        dlq_url = response['QueueUrl']
        print_info(f"DLQ already exists: {queue_name}")
        
        # Get ARN
        attrs = sqs.get_queue_attributes(QueueUrl=dlq_url, AttributeNames=['QueueArn'])
        return attrs['Attributes']['QueueArn']
    except ClientError as e:
        if e.response['Error']['Code'] != 'AWS.SimpleQueueService.NonExistentQueue':
            raise
    
    if dry_run:
        print_dry_run(f"Would create DLQ: {queue_name}")
        return f"arn:aws:sqs:{region}:{account_id}:{queue_name}"
    
    response = sqs.create_queue(
        QueueName=queue_name,
        Attributes={
            'MessageRetentionPeriod': '1209600'  # 14 days
        }
    )
    dlq_url = response['QueueUrl']
    
    # Get the ARN
    attrs = sqs.get_queue_attributes(QueueUrl=dlq_url, AttributeNames=['QueueArn'])
    dlq_arn = attrs['Attributes']['QueueArn']
    
    print_success(f"Created DLQ: {queue_name}")
    return dlq_arn


def create_local_notification_queue(config: dict, context: dict, dlq_arn: str, dry_run: bool) -> tuple:
    """Create the local SQS queue for filtered notifications."""
    print_step(6, "Creating local notification queue")
    
    sqs = context['clients']['sqs']
    queue_name = config['local_sqs']['queue_name']
    account_id = context['account_id']
    region = context['region']
    
    # Check if queue already exists
    try:
        response = sqs.get_queue_url(QueueName=queue_name)
        queue_url = response['QueueUrl']
        print_info(f"Queue already exists: {queue_name}")
        
        # Get ARN
        attrs = sqs.get_queue_attributes(QueueUrl=queue_url, AttributeNames=['QueueArn'])
        return attrs['Attributes']['QueueArn'], queue_url
    except ClientError as e:
        if e.response['Error']['Code'] != 'AWS.SimpleQueueService.NonExistentQueue':
            raise
    
    if dry_run:
        print_dry_run(f"Would create queue: {queue_name}")
        queue_arn = f"arn:aws:sqs:{region}:{account_id}:{queue_name}"
        queue_url = f"https://sqs.{region}.amazonaws.com/{account_id}/{queue_name}"
        return queue_arn, queue_url
    
    redrive_policy = {
        "deadLetterTargetArn": dlq_arn,
        "maxReceiveCount": str(config['local_sqs']['dlq_max_receive_count'])
    }
    
    response = sqs.create_queue(
        QueueName=queue_name,
        Attributes={
            'VisibilityTimeout': str(config['local_sqs']['visibility_timeout_seconds']),
            'MessageRetentionPeriod': str(config['local_sqs']['message_retention_seconds']),
            'RedrivePolicy': json.dumps(redrive_policy)
        }
    )
    queue_url = response['QueueUrl']
    
    # Get the ARN
    attrs = sqs.get_queue_attributes(QueueUrl=queue_url, AttributeNames=['QueueArn'])
    queue_arn = attrs['Attributes']['QueueArn']
    
    print_success(f"Created queue: {queue_name}")
    return queue_arn, queue_url


def create_sqs_queue_policy(config: dict, context: dict, queue_url: str, queue_arn: str, dry_run: bool) -> None:
    """Create SQS queue policy to allow the IAM Role to send messages."""
    print_step(7, "Creating SQS queue policy")
    
    sqs = context['clients']['sqs']
    role_arn = config['existing_resources']['iam_role_arn']
    
    policy = {
        "Version": "2012-10-17",
        "Statement": [
            {
                "Effect": "Allow",
                "Principal": {
                    "AWS": role_arn
                },
                "Action": "sqs:SendMessage",
                "Resource": queue_arn
            }
        ]
    }
    
    if dry_run:
        print_dry_run(f"Would set queue policy for: {queue_arn}")
        return
    
    sqs.set_queue_attributes(
        QueueUrl=queue_url,
        Attributes={
            'Policy': json.dumps(policy)
        }
    )
    print_success("Created SQS queue policy")


def add_local_sqs_permissions(config: dict, context: dict, queue_arn: str, dlq_arn: str, dry_run: bool) -> None:
    """Add local SQS queue permissions to the existing inline policy."""
    print_step(8, "Adding local SQS permissions to existing policy")
    
    iam = context['clients']['iam']
    role_name = config['existing_resources']['iam_role_name']
    policy_name = config['existing_resources']['iam_role_policy_name']
    
    # Get current policy
    try:
        policy_response = iam.get_role_policy(RoleName=role_name, PolicyName=policy_name)
        current_policy = policy_response['PolicyDocument']
    except ClientError as e:
        if e.response['Error']['Code'] == 'NoSuchEntity':
            print_error(f"Policy '{policy_name}' not found on role '{role_name}'")
            sys.exit(1)
        raise
    
    # Check if local SQS permissions already exist
    has_local_sqs_permission = False
    for statement in current_policy.get('Statement', []):
        resources = statement.get('Resource', [])
        if isinstance(resources, str):
            resources = [resources]
        if queue_arn in resources or dlq_arn in resources:
            has_local_sqs_permission = True
            break
    
    if has_local_sqs_permission:
        print_info("Local SQS permissions already exist in policy")
        return
    
    # Add local SQS statement
    local_sqs_statement = {
        "Sid": "LocalSQSQueueAccess",
        "Effect": "Allow",
        "Action": [
            "sqs:ReceiveMessage",
            "sqs:DeleteMessage",
            "sqs:GetQueueAttributes",
            "sqs:GetQueueUrl",
            "sqs:ChangeMessageVisibility",
            "sqs:SendMessage"
        ],
        "Resource": [queue_arn, dlq_arn]
    }
    
    current_policy['Statement'].append(local_sqs_statement)
    
    if dry_run:
        print_dry_run(f"Would add local SQS permissions to policy: {policy_name}")
        return
    
    iam.put_role_policy(
        RoleName=role_name,
        PolicyName=policy_name,
        PolicyDocument=json.dumps(current_policy)
    )
    print_success(f"Added local SQS permissions to existing policy: {policy_name}")


def create_cloudwatch_log_group(config: dict, context: dict, dry_run: bool) -> None:
    """Create CloudWatch Log Group for Lambda function."""
    print_step(9, "Creating CloudWatch Log Group")
    
    logs = context['clients']['logs']
    function_name = config['lambda_function']['function_name']
    log_group_name = f"/aws/lambda/{function_name}"
    retention_days = config['cloudwatch_logs']['retention_days']
    
    # Check if log group already exists
    try:
        response = logs.describe_log_groups(logGroupNamePrefix=log_group_name)
        for lg in response.get('logGroups', []):
            if lg['logGroupName'] == log_group_name:
                print_info(f"Log group already exists: {log_group_name}")
                return
    except ClientError:
        pass
    
    if dry_run:
        print_dry_run(f"Would create log group: {log_group_name}")
        return
    
    logs.create_log_group(logGroupName=log_group_name)
    logs.put_retention_policy(
        logGroupName=log_group_name,
        retentionInDays=retention_days
    )
    print_success(f"Created log group: {log_group_name}")


def create_lambda_function(config: dict, context: dict, target_queue_arn: str, dry_run: bool) -> str:
    """Create the Lambda filter function."""
    print_step(10, "Creating Lambda function")
    
    lambda_client = context['clients']['lambda']
    function_name = config['lambda_function']['function_name']
    role_arn = config['existing_resources']['iam_role_arn']
    
    # Check if function already exists
    try:
        response = lambda_client.get_function(FunctionName=function_name)
        print_info(f"Lambda function already exists: {function_name}")
        return response['Configuration']['FunctionArn']
    except ClientError as e:
        if e.response['Error']['Code'] != 'ResourceNotFoundException':
            raise
    
    if dry_run:
        print_dry_run(f"Would create Lambda function: {function_name}")
        return f"arn:aws:lambda:{context['region']}:{context['account_id']}:function:{function_name}"
    
    # Wait a moment for IAM changes to propagate
    print_info("Waiting for IAM changes to propagate...")
    time.sleep(10)
    
    response = lambda_client.create_function(
        FunctionName=function_name,
        Runtime=config['lambda_function']['runtime'],
        Role=role_arn,
        Handler=config['lambda_function']['handler'],
        Code={
            'S3Bucket': config['lambda_function']['code_s3_bucket'],
            'S3Key': config['lambda_function']['code_s3_key']
        },
        Timeout=config['lambda_function']['timeout_seconds'],
        MemorySize=config['lambda_function']['memory_size_mb'],
        Environment={
            'Variables': {
                'DAYS_IN_THE_PAST': str(config['filter_settings']['days_in_the_past']),
                'INCLUDE_FILTERS': config['filter_settings']['include_filters'],
                'EXCLUDE_FILTERS': config['filter_settings']['exclude_filters'],
                'TARGET_SQS_ARN': target_queue_arn,
                'LOG_LEVEL': 'INFO'
            }
        }
    )
    
    # Wait for function to be active
    print_info("Waiting for Lambda function to become active...")
    waiter = lambda_client.get_waiter('function_active_v2')
    waiter.wait(FunctionName=function_name)
    
    print_success(f"Created Lambda function: {function_name}")
    return response['FunctionArn']


def create_event_source_mapping(config: dict, context: dict, function_arn: str, dry_run: bool) -> str:
    """Create Event Source Mapping to connect Lambda to cross-account SQS."""
    print_step(11, "Creating Event Source Mapping")
    
    lambda_client = context['clients']['lambda']
    function_name = config['lambda_function']['function_name']
    source_arn = config['cross_account']['sqs_queue_arn']
    
    # Check if mapping already exists
    try:
        response = lambda_client.list_event_source_mappings(
            EventSourceArn=source_arn,
            FunctionName=function_name
        )
        if response['EventSourceMappings']:
            mapping = response['EventSourceMappings'][0]
            print_info(f"Event Source Mapping already exists: {mapping['UUID']}")
            return mapping['UUID']
    except ClientError:
        pass
    
    if dry_run:
        print_dry_run(f"Would create Event Source Mapping for: {source_arn}")
        return "dry-run-uuid"
    
    response = lambda_client.create_event_source_mapping(
        EventSourceArn=source_arn,
        FunctionName=function_name,
        Enabled=True,
        BatchSize=config['event_source_mapping']['batch_size'],
        MaximumBatchingWindowInSeconds=config['event_source_mapping']['maximum_batching_window_seconds'],
        ScalingConfig={
            'MaximumConcurrency': config['event_source_mapping']['maximum_concurrency']
        },
        FunctionResponseTypes=['ReportBatchItemFailures']
    )
    
    print_success(f"Created Event Source Mapping: {response['UUID']}")
    return response['UUID']


def print_summary(config: dict, context: dict, results: dict, dry_run: bool) -> None:
    """Print migration summary."""
    print_header("Migration Summary")
    
    if dry_run:
        print(f"\n{Colors.YELLOW}{Colors.BOLD}THIS WAS A DRY RUN - NO CHANGES WERE MADE{Colors.ENDC}\n")
    else:
        print(f"\n{Colors.GREEN}{Colors.BOLD}MIGRATION COMPLETED SUCCESSFULLY{Colors.ENDC}\n")
    
    print(f"{Colors.BOLD}Resources:{Colors.ENDC}")
    print(f"  Local SQS Queue ARN:  {results.get('queue_arn', 'N/A')}")
    print(f"  Local SQS Queue URL:  {results.get('queue_url', 'N/A')}")
    print(f"  Dead Letter Queue:    {results.get('dlq_arn', 'N/A')}")
    print(f"  Lambda Function ARN:  {results.get('lambda_arn', 'N/A')}")
    print(f"  Event Source Mapping: {results.get('esm_uuid', 'N/A')}")
    
    print(f"\n{Colors.BOLD}Filter Configuration:{Colors.ENDC}")
    print(f"  Days in Past:     {config['filter_settings']['days_in_the_past']}")
    print(f"  Include Filters:  {config['filter_settings']['include_filters']}")
    print(f"  Exclude Filters:  {config['filter_settings']['exclude_filters']}")
    
    if not dry_run:
        print(f"\n{Colors.BOLD}Next Steps:{Colors.ENDC}")
        print(f"  1. Update your Splunk AWS Add-on SQS-Based S3 Input to use the new queue URL:")
        print(f"     {results.get('queue_url', 'N/A')}")
        print(f"  2. Monitor CloudWatch Logs for the Lambda function:")
        print(f"     /aws/lambda/{config['lambda_function']['function_name']}")
        print(f"  3. Verify filtered logs are appearing in Splunk")

    
    # Save results to file
    output_file = f"migration-results-{datetime.now().strftime('%Y%m%d-%H%M%S')}.json"
    if not dry_run:
        with open(output_file, 'w') as f:
            json.dump({
                'timestamp': datetime.now().isoformat(),
                'region': context['region'],
                'account_id': context['account_id'],
                'results': results,
                'config_used': config
            }, f, indent=2)
        print(f"\n{Colors.BOLD}Results saved to:{Colors.ENDC} {output_file}")


def main():
    parser = argparse.ArgumentParser(
        description='Migrate splunk-logserv-remote-s3-connect to splunk-logserv-remote-s3-filter',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  python migrate-to-filter.py --config migration-config.json --region us-east-1
  python migrate-to-filter.py --config migration-config.json --region us-east-1 --dry-run
  python migrate-to-filter.py --config migration-config.json --region us-east-1 --profile my-aws-profile
        """
    )
    parser.add_argument(
        '--config', '-c',
        required=True,
        help='Path to the configuration JSON file'
    )
    parser.add_argument(
        '--region', '-r',
        required=True,
        help='AWS region (must match existing deployment region)'
    )
    parser.add_argument(
        '--dry-run', '-d',
        action='store_true',
        help='Show what would be done without making changes'
    )
    parser.add_argument(
        '--profile', '-p',
        required=False,
        default=None,
        help='AWS CLI profile name (optional, uses default credentials if not specified)'
    )
    
    args = parser.parse_args()
    
    print_header("Splunk LogServ Remote S3 Filter Migration")
    
    if args.dry_run:
        print(f"\n{Colors.YELLOW}{Colors.BOLD}DRY RUN MODE - No changes will be made{Colors.ENDC}")
    
    print(f"\nConfiguration file: {args.config}")
    print(f"AWS Region: {args.region}")
    if args.profile:
        print(f"AWS Profile: {args.profile}")
    
    # Load configuration
    config = load_config(args.config)
    
    # Validate prerequisites and get AWS clients
    context = validate_prerequisites(config, args.region, args.profile, args.dry_run)
    
    results = {}
    
    try:
        # Step 2: Update IAM Role trust policy
        update_iam_role_trust_policy(config, context, args.dry_run)
        
        # Step 3: Attach Lambda execution policy
        attach_lambda_execution_policy(config, context, args.dry_run)
        
        # Step 4: Add CloudWatch Logs permissions
        update_cloudwatch_logs_permissions(config, context, args.dry_run)
        
        # Step 5: Create Dead Letter Queue
        dlq_arn = create_dead_letter_queue(config, context, args.dry_run)
        results['dlq_arn'] = dlq_arn
        
        # Step 6: Create local notification queue
        queue_arn, queue_url = create_local_notification_queue(config, context, dlq_arn, args.dry_run)
        results['queue_arn'] = queue_arn
        results['queue_url'] = queue_url
        
        # Step 7: Create SQS queue policy
        create_sqs_queue_policy(config, context, queue_url, queue_arn, args.dry_run)
        
        # Step 8: Add local SQS permissions to IAM Role
        add_local_sqs_permissions(config, context, queue_arn, dlq_arn, args.dry_run)
        
        # Step 9: Create CloudWatch Log Group
        create_cloudwatch_log_group(config, context, args.dry_run)
        
        # Step 10: Create Lambda function
        lambda_arn = create_lambda_function(config, context, queue_arn, args.dry_run)
        results['lambda_arn'] = lambda_arn
        
        # Step 11: Create Event Source Mapping
        esm_uuid = create_event_source_mapping(config, context, lambda_arn, args.dry_run)
        results['esm_uuid'] = esm_uuid
        
        # Print summary
        print_summary(config, context, results, args.dry_run)
        
    except ClientError as e:
        print_error(f"AWS API Error: {e.response['Error']['Message']}")
        sys.exit(1)
    except Exception as e:
        print_error(f"Unexpected error: {str(e)}")
        raise


if __name__ == '__main__':
    main()
