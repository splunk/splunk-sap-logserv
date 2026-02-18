#!/usr/bin/env python3
"""
Splunk LogServ Remote S3 Filter Migration Rollback Script

This script rolls back the migration performed by migrate-to-filter.py by:
1. Deleting the Event Source Mapping
2. Deleting the Lambda function
3. Deleting the CloudWatch Log Group
4. Removing the local SQS permissions policy from the IAM Role
5. Deleting the local SQS queues (main + DLQ)
6. Removing CloudWatch Logs permissions from inline policy
7. Detaching AWSLambdaBasicExecutionRole managed policy
8. Reverting the IAM Role trust policy to remove Lambda

Note: This script reverts to the original splunk-logserv-remote-s3-connect state.
      After rollback, update your Splunk AWS Add-on to use the cross-account SQS queue URL.

Usage:
    python rollback-filter-migration.py --config migration-config.json --region us-east-1
    python rollback-filter-migration.py --config migration-config.json --region us-east-1 --dry-run
    python rollback-filter-migration.py --config migration-config.json --region us-east-1 --profile my-aws-profile
"""

import argparse
import json
import sys
import os
import time
from datetime import datetime

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
    """Load configuration from JSON file."""
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


def initialize_clients(region: str, profile: str) -> dict:
    """Initialize AWS clients."""
    print_step(1, "Initializing AWS clients")
    
    try:
        # Create session with optional profile
        if profile:
            session = boto3.Session(profile_name=profile, region_name=region)
            print_info(f"Using AWS profile: {profile}")
        else:
            session = boto3.Session(region_name=region)
        
        clients = {
            'iam': session.client('iam'),
            'sqs': session.client('sqs'),
            'lambda': session.client('lambda'),
            'logs': session.client('logs'),
            'sts': session.client('sts')
        }
        
        account_id = get_account_id(clients['sts'])
        print_info(f"AWS Account ID: {account_id}")
        print_info(f"AWS Region: {region}")
        print_success("AWS clients initialized")
        
        return {
            'clients': clients,
            'account_id': account_id,
            'region': region
        }
    except NoCredentialsError:
        print_error("AWS credentials not found. Configure credentials and try again.")
        sys.exit(1)


def delete_event_source_mapping(config: dict, context: dict, dry_run: bool) -> None:
    """Delete the Event Source Mapping."""
    print_step(2, "Deleting Event Source Mapping")
    
    lambda_client = context['clients']['lambda']
    function_name = config['lambda_function']['function_name']
    source_arn = config['cross_account']['sqs_queue_arn']
    
    try:
        response = lambda_client.list_event_source_mappings(
            EventSourceArn=source_arn,
            FunctionName=function_name
        )
        
        if not response['EventSourceMappings']:
            print_info("No Event Source Mapping found")
            return
        
        for mapping in response['EventSourceMappings']:
            uuid = mapping['UUID']
            if dry_run:
                print_dry_run(f"Would delete Event Source Mapping: {uuid}")
            else:
                lambda_client.delete_event_source_mapping(UUID=uuid)
                print_success(f"Deleted Event Source Mapping: {uuid}")
                
    except ClientError as e:
        if e.response['Error']['Code'] == 'ResourceNotFoundException':
            print_info("No Event Source Mapping found")
        else:
            raise


def delete_lambda_function(config: dict, context: dict, dry_run: bool) -> None:
    """Delete the Lambda function."""
    print_step(3, "Deleting Lambda function")
    
    lambda_client = context['clients']['lambda']
    function_name = config['lambda_function']['function_name']
    
    try:
        lambda_client.get_function(FunctionName=function_name)
        
        if dry_run:
            print_dry_run(f"Would delete Lambda function: {function_name}")
            return
        
        lambda_client.delete_function(FunctionName=function_name)
        print_success(f"Deleted Lambda function: {function_name}")
        
    except ClientError as e:
        if e.response['Error']['Code'] == 'ResourceNotFoundException':
            print_info(f"Lambda function not found: {function_name}")
        else:
            raise


def delete_cloudwatch_log_group(config: dict, context: dict, dry_run: bool) -> None:
    """Delete the CloudWatch Log Group."""
    print_step(4, "Deleting CloudWatch Log Group")
    
    logs = context['clients']['logs']
    function_name = config['lambda_function']['function_name']
    log_group_name = f"/aws/lambda/{function_name}"
    
    try:
        response = logs.describe_log_groups(logGroupNamePrefix=log_group_name)
        found = False
        for lg in response.get('logGroups', []):
            if lg['logGroupName'] == log_group_name:
                found = True
                break
        
        if not found:
            print_info(f"Log group not found: {log_group_name}")
            return
        
        if dry_run:
            print_dry_run(f"Would delete log group: {log_group_name}")
            return
        
        logs.delete_log_group(logGroupName=log_group_name)
        print_success(f"Deleted log group: {log_group_name}")
        
    except ClientError as e:
        if e.response['Error']['Code'] == 'ResourceNotFoundException':
            print_info(f"Log group not found: {log_group_name}")
        else:
            raise


def remove_local_sqs_permissions(config: dict, context: dict, dry_run: bool) -> None:
    """Remove local SQS permissions from the existing inline policy."""
    print_step(5, "Removing local SQS permissions from existing policy")
    
    iam = context['clients']['iam']
    role_name = config['existing_resources']['iam_role_name']
    policy_name = config['existing_resources']['iam_role_policy_name']
    queue_name = config['local_sqs']['queue_name']
    
    try:
        policy_response = iam.get_role_policy(RoleName=role_name, PolicyName=policy_name)
        current_policy = policy_response['PolicyDocument']
    except ClientError as e:
        if e.response['Error']['Code'] == 'NoSuchEntity':
            print_info(f"Policy not found: {policy_name}")
            return
        raise
    
    # Find and remove local SQS statements
    new_statements = []
    removed = False
    
    for statement in current_policy.get('Statement', []):
        # Check if this is the local SQS statement (by Sid or by resource pattern)
        sid = statement.get('Sid', '')
        resources = statement.get('Resource', [])
        if isinstance(resources, str):
            resources = [resources]
        
        # Check if this statement references our local queue
        is_local_sqs_statement = (
            sid == 'LocalSQSQueueAccess' or
            any(queue_name in str(r) for r in resources)
        )
        
        if is_local_sqs_statement:
            removed = True
            continue
        
        new_statements.append(statement)
    
    if not removed:
        print_info("No local SQS permissions found to remove")
        return
    
    current_policy['Statement'] = new_statements
    
    if dry_run:
        print_dry_run(f"Would remove local SQS permissions from: {policy_name}")
        return
    
    iam.put_role_policy(
        RoleName=role_name,
        PolicyName=policy_name,
        PolicyDocument=json.dumps(current_policy)
    )
    print_success(f"Removed local SQS permissions from policy: {policy_name}")


def delete_local_sqs_queues(config: dict, context: dict, dry_run: bool) -> None:
    """Delete the local SQS queues (main + DLQ)."""
    print_step(6, "Deleting local SQS queues")
    
    sqs = context['clients']['sqs']
    queue_name = config['local_sqs']['queue_name']
    dlq_name = queue_name + "-dlq"
    
    for name in [queue_name, dlq_name]:
        try:
            response = sqs.get_queue_url(QueueName=name)
            queue_url = response['QueueUrl']
            
            if dry_run:
                print_dry_run(f"Would delete queue: {name}")
                continue
            
            sqs.delete_queue(QueueUrl=queue_url)
            print_success(f"Deleted queue: {name}")
            
        except ClientError as e:
            if e.response['Error']['Code'] == 'AWS.SimpleQueueService.NonExistentQueue':
                print_info(f"Queue not found: {name}")
            else:
                raise


def remove_cloudwatch_logs_permissions(config: dict, context: dict, dry_run: bool) -> None:
    """Remove CloudWatch Logs permissions from the inline policy."""
    print_step(7, "Removing CloudWatch Logs permissions from inline policy")
    
    iam = context['clients']['iam']
    role_name = config['existing_resources']['iam_role_name']
    account_id = context['account_id']
    region = context['region']
    policy_name = config['existing_resources']['iam_role_policy_name']
    
    try:
        policy_response = iam.get_role_policy(RoleName=role_name, PolicyName=policy_name)
        current_policy = policy_response['PolicyDocument']
    except ClientError as e:
        if e.response['Error']['Code'] == 'NoSuchEntity':
            print_info(f"Policy not found: {policy_name}")
            return
        raise
    
    # Find and remove CloudWatch Logs statements
    logs_resource = f"arn:aws:logs:{region}:{account_id}:log-group:/aws/lambda/*"
    new_statements = []
    removed = False
    
    for statement in current_policy.get('Statement', []):
        sid = statement.get('Sid', '')
        resources = statement.get('Resource', [])
        if isinstance(resources, str):
            resources = [resources]
        
        actions = statement.get('Action', [])
        if isinstance(actions, str):
            actions = [actions]
        
        # Check if this is the CloudWatch Logs statement we added (by Sid or by resource/action)
        is_logs_statement = (
            sid == 'LambdaCloudWatchLogsAccess' or
            (logs_resource in resources and 
             ('logs:PutLogEvents' in actions or 'logs:CreateLogStream' in actions))
        )
        
        if is_logs_statement:
            removed = True
            continue
        
        new_statements.append(statement)
    
    if not removed:
        print_info("No CloudWatch Logs permissions found to remove")
        return
    
    current_policy['Statement'] = new_statements
    
    if dry_run:
        print_dry_run(f"Would remove CloudWatch Logs statement from: {policy_name}")
        return
    
    iam.put_role_policy(
        RoleName=role_name,
        PolicyName=policy_name,
        PolicyDocument=json.dumps(current_policy)
    )
    print_success("Removed CloudWatch Logs permissions from inline policy")


def detach_lambda_execution_policy(config: dict, context: dict, dry_run: bool) -> None:
    """Detach AWSLambdaBasicExecutionRole managed policy from the role."""
    print_step(8, "Detaching Lambda execution managed policy")
    
    iam = context['clients']['iam']
    role_name = config['existing_resources']['iam_role_name']
    policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
    
    # Check if policy is attached
    attached_policies = iam.list_attached_role_policies(RoleName=role_name)
    found = False
    for policy in attached_policies['AttachedPolicies']:
        if policy['PolicyArn'] == policy_arn:
            found = True
            break
    
    if not found:
        print_info("AWSLambdaBasicExecutionRole is not attached")
        return
    
    if dry_run:
        print_dry_run(f"Would detach policy: {policy_arn}")
        return
    
    iam.detach_role_policy(RoleName=role_name, PolicyArn=policy_arn)
    print_success("Detached AWSLambdaBasicExecutionRole managed policy")


def revert_iam_role_trust_policy(config: dict, context: dict, dry_run: bool) -> None:
    """Revert IAM Role trust policy to remove Lambda service."""
    print_step(9, "Reverting IAM Role trust policy")
    
    iam = context['clients']['iam']
    role_name = config['existing_resources']['iam_role_name']
    user_arn = config['existing_resources']['iam_user_arn']
    
    # Get current trust policy
    role = iam.get_role(RoleName=role_name)
    current_policy = role['Role']['AssumeRolePolicyDocument']
    
    # Check if Lambda is in the trust policy
    has_lambda = False
    for statement in current_policy.get('Statement', []):
        principal = statement.get('Principal', {})
        if isinstance(principal, dict):
            service = principal.get('Service', '')
            if service == 'lambda.amazonaws.com' or (isinstance(service, list) and 'lambda.amazonaws.com' in service):
                has_lambda = True
                break
    
    if not has_lambda:
        print_info("Lambda service is not in the trust policy")
        return
    
    # Create original trust policy (IAM User only)
    original_trust_policy = {
        "Version": "2012-10-17",
        "Statement": [
            {
                "Effect": "Allow",
                "Principal": {
                    "AWS": user_arn
                },
                "Action": "sts:AssumeRole"
            }
        ]
    }
    
    if dry_run:
        print_dry_run(f"Would revert trust policy to original (IAM User only)")
        return
    
    iam.update_assume_role_policy(
        RoleName=role_name,
        PolicyDocument=json.dumps(original_trust_policy)
    )
    print_success("Reverted trust policy to original (removed lambda.amazonaws.com)")


def print_summary(config: dict, context: dict, dry_run: bool) -> None:
    """Print rollback summary."""
    print_header("Rollback Summary")
    
    if dry_run:
        print(f"\n{Colors.YELLOW}{Colors.BOLD}THIS WAS A DRY RUN - NO CHANGES WERE MADE{Colors.ENDC}\n")
    else:
        print(f"\n{Colors.GREEN}{Colors.BOLD}ROLLBACK COMPLETED SUCCESSFULLY{Colors.ENDC}\n")
    
    print(f"{Colors.BOLD}Removed Resources:{Colors.ENDC}")
    print(f"  - Event Source Mapping")
    print(f"  - Lambda function: {config['lambda_function']['function_name']}")
    print(f"  - CloudWatch Log Group: /aws/lambda/{config['lambda_function']['function_name']}")
    print(f"  - Local SQS Queue: {config['local_sqs']['queue_name']}")
    print(f"  - Local SQS DLQ: {config['local_sqs']['queue_name']}-dlq")
    
    print(f"\n{Colors.BOLD}Reverted IAM Role:{Colors.ENDC}")
    print(f"  - Removed lambda.amazonaws.com from trust policy")
    print(f"  - Detached AWSLambdaBasicExecutionRole")
    print(f"  - Removed CloudWatch Logs permissions from {config['existing_resources']['iam_role_policy_name']}")
    print(f"  - Removed local SQS permissions from {config['existing_resources']['iam_role_policy_name']}")
    
    if not dry_run:
        print(f"\n{Colors.BOLD}Next Steps:{Colors.ENDC}")
        print(f"  1. Update your Splunk AWS Add-on SQS-Based S3 Input to use the cross-account SQS queue URL:")
        cross_account_arn = config['cross_account']['sqs_queue_arn']
        # Convert ARN to URL format
        parts = cross_account_arn.split(':')
        region = parts[3]
        account = parts[4]
        queue_name = parts[5]
        cross_account_url = f"https://sqs.{region}.amazonaws.com/{account}/{queue_name}"
        print(f"     {cross_account_url}")
        print(f"  2. Verify logs are being ingested directly from the SAP ECS SQS queue")
    
    # Save rollback log
    if not dry_run:
        log_file = f"rollback-log-{datetime.now().strftime('%Y%m%d-%H%M%S')}.json"
        with open(log_file, 'w') as f:
            json.dump({
                'timestamp': datetime.now().isoformat(),
                'region': context['region'],
                'account_id': context['account_id'],
                'config_used': config,
                'action': 'rollback'
            }, f, indent=2)
        print(f"\n{Colors.BOLD}Rollback log saved to:{Colors.ENDC} {log_file}")


def main():
    parser = argparse.ArgumentParser(
        description='Rollback splunk-logserv-remote-s3-filter migration',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  python rollback-filter-migration.py --config migration-config.json --region us-east-1
  python rollback-filter-migration.py --config migration-config.json --region us-east-1 --dry-run
  python rollback-filter-migration.py --config migration-config.json --region us-east-1 --profile my-aws-profile
        """
    )
    parser.add_argument(
        '--config', '-c',
        required=True,
        help='Path to the configuration JSON file (same one used for migration)'
    )
    parser.add_argument(
        '--region', '-r',
        required=True,
        help='AWS region'
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
    
    print_header("Splunk LogServ Filter Migration Rollback")
    
    if args.dry_run:
        print(f"\n{Colors.YELLOW}{Colors.BOLD}DRY RUN MODE - No changes will be made{Colors.ENDC}")
    else:
        print(f"\n{Colors.RED}{Colors.BOLD}WARNING: This will delete resources and revert IAM changes!{Colors.ENDC}")
    
    print(f"\nConfiguration file: {args.config}")
    print(f"AWS Region: {args.region}")
    if args.profile:
        print(f"AWS Profile: {args.profile}")
    
    # Load configuration
    config = load_config(args.config)
    
    # Initialize AWS clients
    context = initialize_clients(args.region, args.profile)
    
    try:
        # Step 2: Delete Event Source Mapping (must be first)
        delete_event_source_mapping(config, context, args.dry_run)
        
        # Step 3: Delete Lambda function
        delete_lambda_function(config, context, args.dry_run)
        
        # Step 4: Delete CloudWatch Log Group
        delete_cloudwatch_log_group(config, context, args.dry_run)
        
        # Step 5: Remove local SQS permissions from existing policy
        remove_local_sqs_permissions(config, context, args.dry_run)
        
        # Step 6: Delete local SQS queues
        delete_local_sqs_queues(config, context, args.dry_run)
        
        # Step 7: Remove CloudWatch Logs permissions from inline policy
        remove_cloudwatch_logs_permissions(config, context, args.dry_run)
        
        # Step 8: Detach Lambda execution policy
        detach_lambda_execution_policy(config, context, args.dry_run)
        
        # Step 9: Revert IAM Role trust policy
        revert_iam_role_trust_policy(config, context, args.dry_run)
        
        # Print summary
        print_summary(config, context, args.dry_run)
        
    except ClientError as e:
        print_error(f"AWS API Error: {e.response['Error']['Message']}")
        sys.exit(1)
    except Exception as e:
        print_error(f"Unexpected error: {str(e)}")
        raise


if __name__ == '__main__':
    main()
