"""
S3 Event Filter and Forwarder Lambda Function

This Lambda function:
1. Is triggered by messages from a cross-account SQS queue containing S3 event notifications
2. Validates the event is an S3 ObjectCreated event
3. Retrieves and decompresses (if GZIP) the S3 object content
4. Parses NDJSON content (one JSON object per line - SAP LogServ format)
5. Filters messages based on:
   - Time: '_time' attribute must be within DAYS_IN_THE_PAST
   - Include filters: clz_dir/clz_subdir must match at least one INCLUDE_FILTERS pattern
   - Exclude filters: clz_dir/clz_subdir must NOT match any EXCLUDE_FILTERS pattern
6. Forwards matching messages if ANY record in the file passes all filters

Environment Variables:
    DAYS_IN_THE_PAST: Number of days to look back for valid messages
    INCLUDE_FILTERS: Comma-separated fnmatch patterns (e.g., "hana/hanaaudit,linux/*")
    EXCLUDE_FILTERS: Comma-separated fnmatch patterns to exclude (optional)
    TARGET_SQS_ARN: ARN of the target SQS queue to forward messages to
"""

import json
import os
import gzip
import logging
import time
from fnmatch import fnmatch
from typing import Any
from urllib.parse import unquote_plus

import boto3
from botocore.exceptions import ClientError

# Configure logging
logger = logging.getLogger()
logger.setLevel(logging.INFO)

# Initialize AWS clients
s3_client = boto3.client('s3')
sqs_client = boto3.client('sqs')


def get_env_variable(name: str, required: bool = True, default: str = None) -> str | None:
    """
    Retrieve an environment variable.
    
    Args:
        name: Name of the environment variable
        required: Whether the variable is required
        default: Default value if not required and not set
        
    Returns:
        The environment variable value or default
        
    Raises:
        ValueError: If required variable is not set
    """
    value = os.environ.get(name, '').strip()
    if not value:
        if required:
            raise ValueError(f"Required environment variable '{name}' is not set")
        return default
    return value


def parse_filter_patterns(filter_string: str | None) -> list[str]:
    """
    Parse a comma-separated filter string into a list of patterns.
    
    Args:
        filter_string: Comma-separated filter patterns
        
    Returns:
        List of filter patterns (empty list if input is None or empty)
    """
    if not filter_string:
        return []
    return [pattern.strip() for pattern in filter_string.split(',') if pattern.strip()]


def matches_any_pattern(path: str, patterns: list[str]) -> bool:
    """
    Check if a path matches any of the given fnmatch patterns.
    
    Args:
        path: The path to check (e.g., "linux/syslog")
        patterns: List of fnmatch patterns (e.g., ["linux/*", "hana/hanaaudit"])
        
    Returns:
        True if path matches at least one pattern, False otherwise
    """
    for pattern in patterns:
        if fnmatch(path, pattern):
            logger.debug(f"Path '{path}' matched pattern '{pattern}'")
            return True
    return False


def calculate_cutoff_timestamp(days_in_past: int) -> int:
    """
    Calculate the Unix epoch timestamp for the cutoff date.
    
    Args:
        days_in_past: Number of days to look back
        
    Returns:
        10-digit Unix epoch timestamp representing (now - days_in_past)
    """
    current_time = int(time.time())
    seconds_in_past = days_in_past * 24 * 60 * 60
    cutoff_timestamp = current_time - seconds_in_past
    logger.info(f"Cutoff timestamp calculated: {cutoff_timestamp} ({days_in_past} days ago)")
    return cutoff_timestamp


def extract_timestamp_from_time_field(time_value: Any) -> int | None:
    """
    Extract the first 10 numeric characters from the '_time' field.
    
    Args:
        time_value: The value of the '_time' attribute (can be string, int, float)
        
    Returns:
        10-digit integer timestamp or None if extraction fails
    """
    try:
        time_str = str(time_value)
        # Extract first 10 numeric characters
        numeric_chars = ''.join(c for c in time_str if c.isdigit())[:10]
        if len(numeric_chars) == 10:
            return int(numeric_chars)
        logger.warning(f"Could not extract 10-digit timestamp from '_time': {time_value}")
        return None
    except Exception as e:
        logger.warning(f"Error extracting timestamp from '_time' value '{time_value}': {e}")
        return None


def is_gzip_compressed(content: bytes) -> bool:
    """
    Check if content is GZIP compressed by examining magic bytes.
    
    Args:
        content: The raw bytes content
        
    Returns:
        True if content starts with GZIP magic bytes, False otherwise
    """
    return len(content) >= 2 and content[0:2] == b'\x1f\x8b'


def get_s3_object_content(bucket: str, key: str) -> bytes | None:
    """
    Retrieve S3 object content, handling GZIP decompression if needed.
    
    Args:
        bucket: S3 bucket name
        key: S3 object key
        
    Returns:
        Decompressed content as bytes, or None on failure
    """
    try:
        logger.info(f"Retrieving S3 object: s3://{bucket}/{key}")
        response = s3_client.get_object(Bucket=bucket, Key=key)
        content = response['Body'].read()
        
        # Check for GZIP compression and decompress if needed
        if is_gzip_compressed(content):
            logger.info("Content is GZIP compressed, decompressing...")
            content = gzip.decompress(content)
            
        return content
        
    except ClientError as e:
        error_code = e.response['Error']['Code']
        logger.error(f"Failed to retrieve S3 object s3://{bucket}/{key}: {error_code} - {e}")
        return None
    except gzip.BadGzipFile as e:
        logger.error(f"Failed to decompress GZIP content from s3://{bucket}/{key}: {e}")
        return None
    except Exception as e:
        logger.error(f"Unexpected error retrieving S3 object s3://{bucket}/{key}: {e}")
        return None


def parse_s3_event_record(record: dict) -> dict | None:
    """
    Parse and validate an S3 event record from the SQS message.
    
    Args:
        record: S3 event record from the notification
        
    Returns:
        Dict with bucket and key, or None if invalid
    """
    try:
        event_source = record.get('eventSource')
        event_name = record.get('eventName', '')
        
        # Validate eventSource
        if event_source != 'aws:s3':
            logger.info(f"Skipping non-S3 event. eventSource: {event_source}")
            return None
            
        # Validate eventName starts with ObjectCreated
        if not event_name.startswith('ObjectCreated'):
            logger.info(f"Skipping non-ObjectCreated event. eventName: {event_name}")
            return None
            
        # Extract bucket and key
        s3_info = record.get('s3', {})
        bucket = s3_info.get('bucket', {}).get('name')
        key = s3_info.get('object', {}).get('key')
        
        if not bucket or not key:
            logger.warning(f"Missing bucket or key in S3 event record")
            return None
            
        # URL decode the key (S3 event notifications URL-encode keys)
        key = unquote_plus(key)
        
        return {'bucket': bucket, 'key': key}
        
    except Exception as e:
        logger.error(f"Error parsing S3 event record: {e}")
        return None


def send_to_target_sqs(message_body: str, target_queue_url: str) -> bool:
    """
    Send a message to the target SQS queue.
    
    Args:
        message_body: The original SQS message body to forward
        target_queue_url: URL of the target SQS queue
        
    Returns:
        True if successful, False otherwise
    """
    try:
        response = sqs_client.send_message(
            QueueUrl=target_queue_url,
            MessageBody=message_body
        )
        logger.info(f"Message sent to target SQS. MessageId: {response['MessageId']}")
        return True
    except ClientError as e:
        logger.error(f"Failed to send message to target SQS: {e}")
        return False


def get_queue_url_from_arn(queue_arn: str) -> str:
    """
    Convert an SQS ARN to a queue URL.
    
    Args:
        queue_arn: ARN of the SQS queue (e.g., arn:aws:sqs:us-east-1:123456789012:my-queue)
        
    Returns:
        Queue URL (e.g., https://sqs.us-east-1.amazonaws.com/123456789012/my-queue)
    """
    # Parse ARN: arn:aws:sqs:region:account-id:queue-name
    arn_parts = queue_arn.split(':')
    region = arn_parts[3]
    account_id = arn_parts[4]
    queue_name = arn_parts[5]
    
    return f"https://sqs.{region}.amazonaws.com/{account_id}/{queue_name}"


def process_message(sqs_message: dict, config: dict) -> bool:
    """
    Process a single SQS message containing S3 event notifications.
    
    Args:
        sqs_message: The SQS message record
        config: Configuration dict with filters and settings
        
    Returns:
        True if message was processed successfully (forwarded or intentionally discarded),
        False if an error occurred that should trigger a retry
    """
    message_id = sqs_message.get('messageId', 'unknown')
    message_body = sqs_message.get('body', '')
    
    logger.info(f"Processing message: {message_id}")
    
    try:
        # Parse the SQS message body (contains S3 event notification)
        s3_event = json.loads(message_body)
    except json.JSONDecodeError as e:
        logger.error(f"Failed to parse SQS message body as JSON: {e}")
        # Discard malformed messages
        return True
    
    # Handle SNS-wrapped messages (S3 -> SNS -> SQS pattern)
    if 'Records' not in s3_event and 'Message' in s3_event:
        try:
            s3_event = json.loads(s3_event['Message'])
        except json.JSONDecodeError as e:
            logger.error(f"Failed to parse SNS Message as JSON: {e}")
            return True
    
    # Process each S3 event record
    records = s3_event.get('Records', [])
    if not records:
        logger.warning(f"No Records found in S3 event notification")
        return True
    
    # For simplicity, process the first valid S3 record
    # (typically there's one record per notification)
    for record in records:
        s3_info = parse_s3_event_record(record)
        if not s3_info:
            continue
            
        bucket = s3_info['bucket']
        key = s3_info['key']
        
        # Retrieve S3 object content
        content = get_s3_object_content(bucket, key)
        if content is None:
            logger.warning(f"Could not retrieve S3 object, discarding message")
            return True
        
        # Parse NDJSON content (one JSON object per line)
        try:
            content_str = content.decode('utf-8')
        except UnicodeDecodeError as e:
            logger.error(f"Failed to decode S3 object content as UTF-8: {e}")
            return True
        
        # Split into lines and parse each JSON object
        lines = [line.strip() for line in content_str.strip().split('\n') if line.strip()]
        if not lines:
            logger.warning(f"S3 object is empty, discarding message")
            return True
        
        json_records = []
        for i, line in enumerate(lines):
            try:
                json_records.append(json.loads(line))
            except json.JSONDecodeError as e:
                logger.warning(f"Failed to parse line {i+1} as JSON: {e}")
                continue
        
        if not json_records:
            logger.error(f"No valid JSON records found in S3 object, discarding message")
            return True
        
        logger.info(f"Parsed {len(json_records)} JSON record(s) from S3 object")
        
        # Check if ANY record passes all filters
        any_record_passed = False
        for i, json_content in enumerate(json_records):
            # Extract required attributes
            time_value = json_content.get('_time')
            clz_dir = json_content.get('clz_dir', '')
            clz_subdir = json_content.get('clz_subdir', '')
            
            if time_value is None:
                logger.debug(f"Record {i+1}: Missing '_time' attribute, skipping")
                continue
            
            # Time-based filtering
            message_timestamp = extract_timestamp_from_time_field(time_value)
            if message_timestamp is None:
                logger.debug(f"Record {i+1}: Could not extract valid timestamp, skipping")
                continue
                
            if message_timestamp < config['cutoff_timestamp']:
                logger.debug(
                    f"Record {i+1}: Timestamp {message_timestamp} older than cutoff "
                    f"{config['cutoff_timestamp']}, skipping"
                )
                continue
            
            # Build the path for filtering
            filter_path = f"{clz_dir}/{clz_subdir}"
            
            # Include filter check (must match at least one pattern)
            if not config['include_patterns']:
                logger.debug(f"Record {i+1}: No INCLUDE_FILTERS configured, skipping")
                continue
                
            if not matches_any_pattern(filter_path, config['include_patterns']):
                logger.debug(f"Record {i+1}: Path '{filter_path}' does not match include patterns, skipping")
                continue
            
            # Exclude filter check (must not match any pattern)
            if config['exclude_patterns'] and matches_any_pattern(filter_path, config['exclude_patterns']):
                logger.debug(f"Record {i+1}: Path '{filter_path}' matches exclude pattern, skipping")
                continue
            
            # This record passed all filters!
            logger.info(f"Record {i+1}: Path '{filter_path}' passed all filters")
            any_record_passed = True
            break  # No need to check more records
        
        if not any_record_passed:
            logger.info(f"No records in S3 object passed filters, discarding message")
            return True
        
        # At least one record passed - forward to target SQS
        logger.info(f"Message passed filters (at least one record matched), forwarding to target SQS")
        success = send_to_target_sqs(message_body, config['target_queue_url'])
        
        if not success:
            logger.error(f"Failed to forward message to target SQS, discarding")
            return True
        
        # Successfully processed this record
        return True
    
    # No valid S3 records found
    logger.info("No valid S3 ObjectCreated events found in message")
    return True


def lambda_handler(event: dict, context: Any) -> dict:
    """
    Lambda handler for processing SQS messages with S3 event notifications.
    
    Args:
        event: Lambda event containing SQS records
        context: Lambda context
        
    Returns:
        Partial batch response indicating which messages failed
    """
    logger.info(f"Received event with {len(event.get('Records', []))} records")
    
    # Load configuration from environment variables
    try:
        days_in_past = int(get_env_variable('DAYS_IN_THE_PAST'))
        include_filters = get_env_variable('INCLUDE_FILTERS', required=False, default='')
        exclude_filters = get_env_variable('EXCLUDE_FILTERS', required=False, default='')
        target_sqs_arn = get_env_variable('TARGET_SQS_ARN')
    except ValueError as e:
        logger.error(f"Configuration error: {e}")
        # Fail all messages if configuration is invalid
        return {
            'batchItemFailures': [
                {'itemIdentifier': record['messageId']}
                for record in event.get('Records', [])
            ]
        }
    
    # Parse filter patterns
    include_patterns = parse_filter_patterns(include_filters)
    exclude_patterns = parse_filter_patterns(exclude_filters)
    
    logger.info(f"Include patterns: {include_patterns}")
    logger.info(f"Exclude patterns: {exclude_patterns}")
    
    # Prepare configuration
    config = {
        'cutoff_timestamp': calculate_cutoff_timestamp(days_in_past),
        'include_patterns': include_patterns,
        'exclude_patterns': exclude_patterns,
        'target_queue_url': get_queue_url_from_arn(target_sqs_arn)
    }
    
    # Track failed messages for partial batch response
    batch_item_failures = []
    
    # Process each SQS message
    for record in event.get('Records', []):
        message_id = record.get('messageId', 'unknown')
        
        try:
            success = process_message(record, config)
            if not success:
                batch_item_failures.append({'itemIdentifier': message_id})
        except Exception as e:
            logger.error(f"Unexpected error processing message {message_id}: {e}", exc_info=True)
            # Per requirements: discard with logging on failure
            # We don't add to batch_item_failures, so message won't retry
    
    logger.info(
        f"Processing complete. "
        f"Total: {len(event.get('Records', []))}, "
        f"Failures: {len(batch_item_failures)}"
    )
    
    return {'batchItemFailures': batch_item_failures}