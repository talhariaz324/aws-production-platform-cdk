#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { FoundationStack } from '../lib/foundation-stack';

const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION ?? 'us-east-1',
};

const projectName = 'acme-platform';

const app = new cdk.App();

const foundation = new FoundationStack(app, 'AcmePlatformFoundationStack', {
  env,
  projectName,
  description: 'VPC, subnets, NAT, VPC endpoints, security groups, KMS, IAM roles',
});

cdk.Tags.of(foundation).add('Project', projectName);
cdk.Tags.of(foundation).add('Environment', 'production');
cdk.Tags.of(foundation).add('ManagedBy', 'cdk');
