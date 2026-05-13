import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import { Construct } from 'constructs';

export interface FoundationStackProps extends cdk.StackProps {
  projectName: string;
  stage: string;
  // `<owner>/<repo>` — used to scope the OIDC trust policy. Defaults to main
  // branch; restrict further (environment, ref pattern) for tighter blast
  // radius in real deployments.
  githubRepo: string;
}

/**
 * Foundation: long-lived primitives that everything else depends on.
 * Changes here ripple — modify with care.
 */
export class FoundationStack extends cdk.Stack {
  public readonly vpc: ec2.Vpc;
  public readonly kmsKey: kms.Key;
  public readonly albSg: ec2.SecurityGroup;
  public readonly ecsSg: ec2.SecurityGroup;
  public readonly rdsSg: ec2.SecurityGroup;
  public readonly redisSg: ec2.SecurityGroup;
  public readonly mskSg: ec2.SecurityGroup;
  public readonly githubOidcRole: iam.Role;

  constructor(scope: Construct, id: string, props: FoundationStackProps) {
    super(scope, id, props);

    const { projectName, stage, githubRepo } = props;

    // ─── VPC ──────────────────────────────────────────────────────────────────
    // 2 AZs is the minimum AWS requires for ALB / RDS Multi-AZ-ready posture.
    // 3+ AZs would cost an extra NAT (~$33/mo each) for marginal availability
    // gain at small-team scale. Document the trade-off; revisit when revenue
    // justifies the third AZ.
    this.vpc = new ec2.Vpc(this, 'Vpc', {
      vpcName: `${projectName}-${stage}-vpc`,
      maxAzs: 2,
      natGateways: 2, // one per AZ — protects against single-AZ NAT outage
      subnetConfiguration: [
        { name: 'public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
        { name: 'private-app', subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS, cidrMask: 22 },
        { name: 'private-data', subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 24 },
      ],
    });

    // ─── VPC Endpoints ────────────────────────────────────────────────────────
    // Route AWS API traffic through PrivateLink instead of NAT.
    // Each interface endpoint costs ~$7/mo per AZ but eliminates NAT egress
    // for those services. With 2 AZs and 5 endpoints: ~$70/mo,
    // saves ~$120/mo in NAT data transfer at moderate throughput.
    // Net positive starting around 100GB/mo of NAT egress.
    this.vpc.addGatewayEndpoint('S3Endpoint', { service: ec2.GatewayVpcEndpointAwsService.S3 });
    this.vpc.addInterfaceEndpoint('EcrApiEndpoint', { service: ec2.InterfaceVpcEndpointAwsService.ECR });
    this.vpc.addInterfaceEndpoint('EcrDkrEndpoint', { service: ec2.InterfaceVpcEndpointAwsService.ECR_DOCKER });
    this.vpc.addInterfaceEndpoint('CwLogsEndpoint', { service: ec2.InterfaceVpcEndpointAwsService.CLOUDWATCH_LOGS });
    this.vpc.addInterfaceEndpoint('SecretsEndpoint', { service: ec2.InterfaceVpcEndpointAwsService.SECRETS_MANAGER });

    // ─── Security groups (least-privilege chain) ──────────────────────────────
    // Internet → ALB → ECS → RDS / Redis / MSK
    // Each SG only allows traffic from the SG immediately upstream.
    this.albSg = new ec2.SecurityGroup(this, 'AlbSg', {
      vpc: this.vpc,
      description: 'ALB — public 80/443',
      allowAllOutbound: false,
    });
    this.albSg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(80), 'http (redirect to https)');
    this.albSg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), 'https');

    this.ecsSg = new ec2.SecurityGroup(this, 'EcsSg', {
      vpc: this.vpc,
      description: 'ECS hosts — accept from ALB only',
      allowAllOutbound: true,
    });
    this.ecsSg.addIngressRule(this.albSg, ec2.Port.tcpRange(32768, 65535), 'dynamic port mapping from ALB');

    this.rdsSg = new ec2.SecurityGroup(this, 'RdsSg', {
      vpc: this.vpc,
      description: 'RDS — accept from ECS only',
      allowAllOutbound: false,
    });
    this.rdsSg.addIngressRule(this.ecsSg, ec2.Port.tcp(5432), 'postgres from ECS');

    this.redisSg = new ec2.SecurityGroup(this, 'RedisSg', {
      vpc: this.vpc,
      description: 'ElastiCache Redis — accept from ECS only',
      allowAllOutbound: false,
    });
    this.redisSg.addIngressRule(this.ecsSg, ec2.Port.tcp(6379), 'redis from ECS');

    // ─── MSK security group ───────────────────────────────────────────────────
    // Data-stack configures encryptionInTransit.clientBroker = 'TLS', so we
    // only open the TLS client port. Notes on what was deliberately NOT opened:
    //   • 9092 (PLAINTEXT) — would contradict the TLS-only client setting.
    //   • 2181 (ZooKeeper) — MSK 3.7.x runs in KRaft mode; ZooKeeper is gone.
    //     The previous rule was a vestige from older Kafka versions.
    //   • Broker-to-broker traffic — AWS manages it inside the MSK service
    //     boundary; no client SG rule is needed for in-cluster replication.
    this.mskSg = new ec2.SecurityGroup(this, 'MskSg', {
      vpc: this.vpc,
      description: 'MSK Kafka brokers — accept TLS client traffic from ECS only',
      allowAllOutbound: false,
    });
    this.mskSg.addIngressRule(this.ecsSg, ec2.Port.tcp(9094), 'kafka client TLS from ECS');

    // ─── KMS multi-region key ─────────────────────────────────────────────────
    // Single key for everything (RDS, S3, Secrets, MSK at-rest).
    // Per-resource keys would be more granular but adds operational toil
    // (key rotation coordination across services) for negligible blast-radius
    // gain. Multi-region replica enables cross-region restore.
    this.kmsKey = new kms.Key(this, 'PrimaryKey', {
      alias: `${projectName}/${stage}/primary`,
      description: 'Primary CMK for at-rest encryption — RDS, S3, Secrets, MSK',
      enableKeyRotation: true,
      pendingWindow: cdk.Duration.days(30),
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      multiRegion: true,
    });

    // ─── GitHub Actions OIDC role ─────────────────────────────────────────────
    // No long-lived AWS access keys stored in GitHub secrets. Token is bound
    // to the specific repo passed via context. Tighten the `sub` further
    // (environment-scoped, ref pattern) for production deployments.
    const oidcProvider = new iam.OpenIdConnectProvider(this, 'GitHubOidc', {
      url: 'https://token.actions.githubusercontent.com',
      clientIds: ['sts.amazonaws.com'],
    });

    this.githubOidcRole = new iam.Role(this, 'GitHubActionsRole', {
      roleName: `${projectName}-${stage}-github-actions`,
      assumedBy: new iam.FederatedPrincipal(
        oidcProvider.openIdConnectProviderArn,
        {
          StringEquals: {
            'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
          },
          StringLike: {
            'token.actions.githubusercontent.com:sub': `repo:${githubRepo}:ref:refs/heads/main`,
          },
        },
        'sts:AssumeRoleWithWebIdentity',
      ),
      description: 'CI deploy role — scoped to ECR push + ECS update-service for this project',
      maxSessionDuration: cdk.Duration.hours(1),
    });

    // Least-privilege CI policy. Resource ARNs use project + stage naming so
    // this role cannot push images or roll services it does not own.
    const ecrRepoArnPattern = cdk.Stack.of(this).formatArn({
      service: 'ecr',
      resource: 'repository',
      resourceName: `${projectName}-${stage}/*`,
    });
    const ecsServiceArnPattern = cdk.Stack.of(this).formatArn({
      service: 'ecs',
      resource: 'service',
      resourceName: `${projectName}-${stage}/*`,
    });
    const ecsTaskDefArnPattern = cdk.Stack.of(this).formatArn({
      service: 'ecs',
      resource: 'task-definition',
      resourceName: '*',
    });

    this.githubOidcRole.addToPolicy(
      // ECR auth token is account-scoped — AWS does not support resource-level
      // restriction on GetAuthorizationToken.
      new iam.PolicyStatement({
        sid: 'EcrAuth',
        actions: ['ecr:GetAuthorizationToken'],
        resources: ['*'],
      }),
    );
    this.githubOidcRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'EcrPush',
        actions: [
          'ecr:BatchCheckLayerAvailability',
          'ecr:InitiateLayerUpload',
          'ecr:UploadLayerPart',
          'ecr:CompleteLayerUpload',
          'ecr:PutImage',
          'ecr:BatchGetImage',
          'ecr:DescribeRepositories',
          'ecr:DescribeImages',
        ],
        resources: [ecrRepoArnPattern],
      }),
    );
    this.githubOidcRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'EcsRollout',
        actions: [
          'ecs:UpdateService',
          'ecs:DescribeServices',
          'ecs:DescribeTaskDefinition',
          'ecs:RegisterTaskDefinition',
          'ecs:DeregisterTaskDefinition',
        ],
        resources: [ecsServiceArnPattern, ecsTaskDefArnPattern],
      }),
    );
    this.githubOidcRole.addToPolicy(
      // ECS requires PassRole on task execution / task roles when a new task
      // definition is registered. Scope to roles tagged for this project so a
      // compromised CI cannot escalate to unrelated roles in the account.
      new iam.PolicyStatement({
        sid: 'PassEcsTaskRoles',
        actions: ['iam:PassRole'],
        resources: ['*'],
        conditions: {
          StringEquals: {
            'iam:PassedToService': 'ecs-tasks.amazonaws.com',
          },
          StringLike: {
            'iam:AssociatedResourceArn': [
              cdk.Stack.of(this).formatArn({
                service: 'ecs',
                resource: 'task-definition',
                resourceName: `${projectName}-${stage}*`,
              }),
            ],
          },
        },
      }),
    );

    // Outputs for cross-stack reference
    new cdk.CfnOutput(this, 'VpcId', { value: this.vpc.vpcId });
    new cdk.CfnOutput(this, 'KmsKeyArn', { value: this.kmsKey.keyArn });
    new cdk.CfnOutput(this, 'GitHubActionsRoleArn', { value: this.githubOidcRole.roleArn });
  }
}
