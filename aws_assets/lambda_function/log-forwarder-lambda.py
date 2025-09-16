import json
import boto3
import os
import logging
import gzip
import io
import mimetypes
from urllib.parse import unquote_plus

# Configure logging
logger = logging.getLogger()
logger.setLevel(logging.INFO)

# Get environment variables with error handling
STAGING_BUCKET = os.environ.get('STAGING_BUCKET')

if not STAGING_BUCKET:
    raise ValueError("STAGING_BUCKET environment variable is required")

# Initialize S3 client (SAP team has granted direct access)
s3_client = boto3.client('s3')

def handler(event, context):
    """
    Lambda function that gets triggered by SQS messages from Account A.
    It copies objects from the source S3 bucket to the staging bucket,
    ungzipping them in the process.
    """
    logger.info(f"Received event: {json.dumps(event)}")
    
    failed_records = []
    
    # Process each record in the SQS event
    for record in event['Records']:
        try:
            # Parse the SQS message body
            message_body = json.loads(record['body'])
            logger.info(f"Processing message: {json.dumps(message_body)}")
            
            # Extract S3 event details from the message
            if 'Records' in message_body:
                for s3_record in message_body['Records']:
                    if (s3_record.get('eventSource') == 'aws:s3' and 
                        s3_record.get('eventName', '').startswith('ObjectCreated') and
                        's3' in s3_record and 'bucket' in s3_record['s3'] and 'object' in s3_record['s3']):
                        
                        # Get source bucket and key
                        source_bucket = s3_record['s3']['bucket']['name']
                        source_key = unquote_plus(s3_record['s3']['object']['key'])
                        
                        # Get the object from source S3 (cross-account access granted by SAP team)
                        logger.info(f"Getting object from s3://{source_bucket}/{source_key}")
                        response = s3_client.get_object(
                            Bucket=source_bucket,
                            Key=source_key
                        )
                        
                        # Read the gzipped content
                        gzipped_content = response['Body'].read()
                        
                        # Determine if the file is gzipped based on extension or content
                        is_gzipped = source_key.endswith('.gz') or (
                            response.get('ContentEncoding') == 'gzip' or
                            (gzipped_content[:2] == b'\x1f\x8b')  # gzip magic number
                        )
                        
                        if is_gzipped:
                            # Ungzip the content
                            logger.info(f"Ungzipping content from {source_key}")
                            try:
                                with gzip.GzipFile(fileobj=io.BytesIO(gzipped_content), mode='rb') as f:
                                    content = f.read()
                                
                                # Determine the output key (remove .gz extension if present)
                                output_key = source_key
                                if output_key.endswith('.gz'):
                                    output_key = output_key[:-3]
                                
                                # Detect content type
                                content_type, _ = mimetypes.guess_type(output_key)
                                content_type = content_type or 'application/octet-stream'
                                
                                # Upload the ungzipped content to staging bucket
                                logger.info(f"Uploading ungzipped content to s3://{STAGING_BUCKET}/{output_key}")
                                s3_client.put_object(
                                    Bucket=STAGING_BUCKET,
                                    Key=output_key,
                                    Body=content,
                                    ContentType=content_type
                                )
                            except Exception as e:
                                logger.error(f"Error ungzipping file: {str(e)}")
                                # If ungzipping fails, upload the original file
                                content_type, _ = mimetypes.guess_type(source_key)
                                content_type = content_type or 'application/octet-stream'
                                
                                logger.info(f"Uploading original file to s3://{STAGING_BUCKET}/{source_key}")
                                s3_client.put_object(
                                    Bucket=STAGING_BUCKET,
                                    Key=source_key,
                                    Body=gzipped_content,
                                    ContentType=content_type
                                )
                        else:
                            # Upload the content as-is
                            content_type, _ = mimetypes.guess_type(source_key)
                            content_type = content_type or 'application/octet-stream'
                            
                            logger.info(f"Uploading content to s3://{STAGING_BUCKET}/{source_key}")
                            s3_client.put_object(
                                Bucket=STAGING_BUCKET,
                                Key=source_key,
                                Body=gzipped_content,
                                ContentType=content_type
                            )
                        
                        logger.info(f"Successfully processed object to s3://{STAGING_BUCKET}/{source_key}")
            else:
                logger.warning(f"Message does not contain S3 records: {json.dumps(message_body)}")
                
        except Exception as e:
            logger.error(f"Error processing record: {str(e)}")
            # Add failed record for SQS batch processing
            failed_records.append({
                'itemIdentifier': record.get('messageId', 'unknown')
            })
            continue
    
    # Return batch item failures for SQS partial batch failure handling
    response = {
        'statusCode': 200,
        'body': json.dumps('Processing completed')
    }
    
    if failed_records:
        response['batchItemFailures'] = failed_records
        logger.warning(f"Failed to process {len(failed_records)} records")
    
    return response