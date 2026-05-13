#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { FoundationStack } from '../lib/foundation-stack';
import { DataStack } from '../lib/data-stack';
import { AppStack } from '../lib/app-stack';
import { FrontendStack } from '../lib/frontend-stack';
import { ObservabilityStack } from '../lib/observability-stack';

const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION ?? 'us-east-1',
};

const projectName = 'acme-platform';

const app = new cdk.App();

// `stage` is a context-driven knob so future envs (dev / staging) can be
// brought up with `cdk synth -c stage=dev`. Today only `prod` is deployed —
// the staging trade-off is documented in docs/interview-defense.md.
const stage = (app.node.tryGetContext('stage') as string | undefined) ?? 'prod';

// `alertEmail` is required for ObservabilityStack. Provide via
// `cdk synth -c alertEmail=oncall@example.com` or fall back to a placeholder
// when synthesizing in CI without context (the resulting template still
// validates; just don't deploy it).
const alertEmail =
  (app.node.tryGetContext('alertEmail') as string | undefined) ?? 'placeholder@example.invalid';

// `githubRepo` shapes the OIDC trust policy `sub` claim. Pass via
// `cdk synth -c githubRepo=owner/repo`.
const githubRepo =
  (app.node.tryGetContext('githubRepo') as string | undefined) ??
  'talhariaz324/aws-production-platform-cdk';

const foundation = new FoundationStack(app, `AcmePlatform-${stage}-FoundationStack`, {
  env,
  projectName,
  stage,
  githubRepo,
  description: 'VPC, subnets, NAT, VPC endpoints, security groups, KMS, OIDC role',
});

const data = new DataStack(app, `AcmePlatform-${stage}-DataStack`, {
  env,
  projectName,
  stage,
  vpc: foundation.vpc,
  kmsKey: foundation.kmsKey,
  rdsSg: foundation.rdsSg,
  redisSg: foundation.redisSg,
  mskSg: foundation.mskSg,
  description: 'RDS Postgres, ElastiCache Redis (x2), MSK Kafka',
});
data.addDependency(foundation);

const appStack = new AppStack(app, `AcmePlatform-${stage}-AppStack`, {
  env,
  projectName,
  stage,
  vpc: foundation.vpc,
  albSg: foundation.albSg,
  ecsSg: foundation.ecsSg,
  description: 'ECS on EC2, ECR repos, ALB, capacity providers per workload class',
});
appStack.addDependency(foundation);

const frontend = new FrontendStack(app, `AcmePlatform-${stage}-FrontendStack`, {
  env,
  projectName,
  stage,
  description: 'CloudFront + S3 distributions per app surface',
});

const observability = new ObservabilityStack(app, `AcmePlatform-${stage}-ObservabilityStack`, {
  env,
  projectName,
  stage,
  alertEmail,
  rdsInstanceIdentifier: data.rdsCluster.instanceIdentifier,
  description: 'CloudWatch alarms, WAF, log retention',
});
observability.addDependency(data);

const stageTag = stage === 'prod' ? 'production' : stage;
for (const stack of [foundation, data, appStack, frontend, observability]) {
  cdk.Tags.of(stack).add('Project', projectName);
  cdk.Tags.of(stack).add('Environment', stageTag);
  cdk.Tags.of(stack).add('ManagedBy', 'cdk');
}
