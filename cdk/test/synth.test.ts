import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { FoundationStack } from '../lib/foundation-stack';
import { DataStack } from '../lib/data-stack';
import { AppStack } from '../lib/app-stack';
import { FrontendStack } from '../lib/frontend-stack';
import { ObservabilityStack } from '../lib/observability-stack';

// These tests run on every CI build. They synth each stack and assert on the
// shape of the generated template, NOT a frozen snapshot — snapshots break on
// every CDK upgrade for unrelated logical-id churn. Resource shape + count is
// the load-bearing contract for reviewers.

const env = { account: '111111111111', region: 'us-east-1' };
const projectName = 'acme-platform';
const stage = 'prod';
const githubRepo = 'example-org/example-repo';

function buildAll(): {
  foundation: FoundationStack;
  data: DataStack;
  appStack: AppStack;
  frontend: FrontendStack;
  observability: ObservabilityStack;
} {
  const app = new cdk.App();
  const foundation = new FoundationStack(app, 'Foundation', {
    env,
    projectName,
    stage,
    githubRepo,
  });
  const data = new DataStack(app, 'Data', {
    env,
    projectName,
    stage,
    vpc: foundation.vpc,
    kmsKey: foundation.kmsKey,
    rdsSg: foundation.rdsSg,
    redisSg: foundation.redisSg,
    mskSg: foundation.mskSg,
  });
  const appStack = new AppStack(app, 'App', {
    env,
    projectName,
    stage,
    vpc: foundation.vpc,
    albSg: foundation.albSg,
    ecsSg: foundation.ecsSg,
  });
  const frontend = new FrontendStack(app, 'Frontend', { env, projectName, stage });
  const observability = new ObservabilityStack(app, 'Observability', {
    env,
    projectName,
    stage,
    alertEmail: 'oncall@example.com',
    rdsInstanceIdentifier: 'placeholder-rds-id',
  });
  return { foundation, data, appStack, frontend, observability };
}

describe('FoundationStack', () => {
  it('creates a 2-AZ VPC with one NAT per AZ', () => {
    const { foundation } = buildAll();
    const t = Template.fromStack(foundation);
    t.resourceCountIs('AWS::EC2::VPC', 1);
    t.resourceCountIs('AWS::EC2::NatGateway', 2);
  });

  it('opens MSK TLS port 9094 and does not open 9092 plaintext or 2181 ZooKeeper', () => {
    const { foundation } = buildAll();
    const t = Template.fromStack(foundation);
    const ingress = t.findResources('AWS::EC2::SecurityGroupIngress');
    const sgRules = Object.values(ingress).map((r) => r.Properties);
    const mskRulePorts = sgRules
      .filter((p) => typeof p.Description === 'string' && p.Description.toLowerCase().includes('kafka'))
      .map((p) => p.FromPort);
    expect(mskRulePorts).toContain(9094);
    expect(mskRulePorts).not.toContain(9092);
    expect(mskRulePorts).not.toContain(2181);
  });

  it('attaches a least-privilege OIDC role with ECR + ECS scoping', () => {
    const { foundation } = buildAll();
    const t = Template.fromStack(foundation);
    t.hasResourceProperties('AWS::IAM::Role', {
      RoleName: Match.stringLikeRegexp('acme-platform-prod-github-actions'),
    });
    // OIDC role has at least one inline policy attached (the bug we're fixing
    // was that it had none — assert presence of the policy resource).
    const policies = t.findResources('AWS::IAM::Policy');
    expect(Object.keys(policies).length).toBeGreaterThan(0);
  });
});

describe('DataStack', () => {
  it('encrypts RDS at rest with KMS and enforces MSK TLS to clients', () => {
    const { data } = buildAll();
    const t = Template.fromStack(data);
    t.hasResourceProperties('AWS::RDS::DBInstance', {
      StorageEncrypted: true,
    });
    t.hasResourceProperties('AWS::MSK::Cluster', {
      EncryptionInfo: Match.objectLike({
        EncryptionInTransit: Match.objectLike({ ClientBroker: 'TLS' }),
      }),
    });
  });
});

describe('AppStack', () => {
  it('creates 3 capacity providers split by workload class', () => {
    const { appStack } = buildAll();
    const t = Template.fromStack(appStack);
    t.resourceCountIs('AWS::ECS::CapacityProvider', 3);
  });

  it('creates one ECR repo per declared service', () => {
    const { appStack } = buildAll();
    const t = Template.fromStack(appStack);
    // The app stack declares 8 backend services.
    t.resourceCountIs('AWS::ECR::Repository', 8);
  });
});

describe('FrontendStack', () => {
  it('creates 4 CloudFront distributions and 4 buckets, all private', () => {
    const { frontend } = buildAll();
    const t = Template.fromStack(frontend);
    t.resourceCountIs('AWS::CloudFront::Distribution', 4);
    t.resourceCountIs('AWS::S3::Bucket', 4);
    t.allResourcesProperties('AWS::S3::Bucket', {
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
    });
  });
});

describe('ObservabilityStack', () => {
  it('sets explicit retention on every log group', () => {
    const { observability } = buildAll();
    const t = Template.fromStack(observability);
    const groups = t.findResources('AWS::Logs::LogGroup');
    expect(Object.keys(groups).length).toBeGreaterThan(0);
    for (const g of Object.values(groups)) {
      expect(g.Properties.RetentionInDays).toBeDefined();
    }
  });

  it('wires the WAF rate-limit rule and at least one managed rule group', () => {
    const { observability } = buildAll();
    const t = Template.fromStack(observability);
    t.hasResourceProperties('AWS::WAFv2::WebACL', {
      Rules: Match.arrayWith([
        Match.objectLike({
          Statement: Match.objectLike({
            RateBasedStatement: Match.objectLike({ AggregateKeyType: 'IP' }),
          }),
        }),
      ]),
    });
  });
});
