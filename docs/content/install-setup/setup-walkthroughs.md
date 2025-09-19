# Setup Walkthroughs Overview

### :material-circle-box:{ .taiconcolor } Introduction
Once the [prerequisites](prerequisites.md) and the [installation of the Splunk TA for SAP LogServ](install-ta.md) have been completed, use the provided setup walkthroughs to complete the setup based on the cloud provider where your SAP ECS environment is running in and your preferred deployment scenario.

### :material-circle-box:{ .taiconcolor } Walkthroughs by Cloud Provider

#### :material-greater-than:{ .taiconcolor } SAP ECS running in Amazon Web Services (AWS)
??? note
    Both deployment scenarios below for AWS require the use of a secondary AWS account (a different AWS account than the one SAP ECS is running in) due to the requirement from SAP for a cross-account IAM Role to access the AWS SAP ECS account where the LogServ logs reside.  Both deployment scenarios also require the use of an AWS IAM User that has an Access Key configured for it as this is a requirement for the Splunk Add-on for Amazon Web Services (AWS).

    If you want to ingest historical logs from the S3 bucket in the SAP ECS account, the [AWS Remote S3 Copy Setup](aws-remote-s3-copy-walkthrough.md) is the recommended approach. Utilizing that approach provides you the ability to copy historical logs from the S3 bucket in the SAP ECS account to a secondary S3 bucket, so they will be ingested into Splunk, with the flexibility to switch over to the [AWS Remote S3 Connect Setup](aws-remote-s3-connect-walkthrough.md) approach afterward.   

#### &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; :material-circle-box:{ .cboxmove } [AWS Remote S3 Connect Setup Walkthrough](aws-remote-s3-connect-walkthrough.md) 
??? indented-note "Note"
    This deployment scenario uses an IAM User with a configured Access Key and a cross-account IAM Role to directly access LogServ resources in the AWS SAP ECS account where the LogServ logs reside without the need to copy logs to a secondary S3 bucket. 

    - No secondary S3 Bucket needed
    - No secondary SQS Queue needed
    - Does not support ingestion of historical logs
    - <a href="https://github.com/splunk/splunk-sap-logserv/blob/main/aws_assets/cloud_formation/splunk-logserv-remote-s3-connect.yaml" target="_blank">CloudFormation Template</a> Provided    
    
    ![image](../../images/aws-remote-s3-connect-architecture.png "Direct Connect Deployment Architecture")

    
#### &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; :material-circle-box:{ .cboxmove } [AWS Remote S3 Copy Setup Walkthrough](aws-remote-s3-copy-walkthrough.md)
??? indented-note "Note"
    This deployment scenario uses an IAM User with a configured Access Key and a cross-account IAM Role along with a secondary S3 bucket and SQS queue. 

    - Greater control of data + retention
    - Requires secondary S3 Bucket
    - Requires secondary SQS Queue
    - Supports ingestion of historical logs
    - <a href="https://github.com/splunk/splunk-sap-logserv/blob/main/aws_assets/cloud_formation/splunk-logserv-remote-s3-copy.yaml" target="_blank">CloudFormation Template</a> Provided    
    
    ![image](../../images/aws-remote-s3-copy-architecture.png "Local S3 Copy Deployment Architecture")