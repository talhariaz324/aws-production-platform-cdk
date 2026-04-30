import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as elasticache from 'aws-cdk-lib/aws-elasticache';
import * as msk from 'aws-cdk-lib/aws-msk';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';

export interface DataStackProps extends cdk.StackProps {
  projectName: string;
  vpc: ec2.IVpc;
  kmsKey: kms.IKey;
  rdsSg: ec2.ISecurityGroup;
  redisSg: ec2.ISecurityGroup;
  mskSg: ec2.ISecurityGroup;
}

/**
 * Data tier: PostgreSQL, Redis (×2), MSK Kafka.
 *
 * Single-AZ RDS at launch is a cost trade-off (Multi-AZ doubles RDS line
 * item). 5–15 min RTO on AZ failure vs. ongoing cash burn. Documented;
 * the trigger to flip Multi-AZ on is "first revenue cohort" or contract
 * requirement.
 */
export class DataStack extends cdk.Stack {
  public readonly rdsCluster: rds.DatabaseInstance;
  public readonly appRedis: elasticache.CfnReplicationGroup;
  public readonly sessionRedis: elasticache.CfnReplicationGroup;
  public readonly mskCluster: msk.CfnCluster;

  constructor(scope: Construct, id: string, props: DataStackProps) {
    super(scope, id, props);

    const { projectName } = props;

    // ─── RDS PostgreSQL ───────────────────────────────────────────────────────
    // db.t3.large balances cost and headroom for ~10 services on a
    // schema-per-service pattern. Each service owns a schema in one DB
    // instance — share infra, isolate logically. Single-AZ deferred until
    // revenue covers the +$ cost (see docs/cost-optimization.md).
    const dbCredentials = new secretsmanager.Secret(this, 'DbCredentials', {
      secretName: `${projectName}/prod/rds-master`,
      description: 'RDS master credentials',
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ username: 'platform_admin' }),
        generateStringKey: 'password',
        excludePunctuation: true,
        passwordLength: 32,
      },
      encryptionKey: props.kmsKey,
    });

    this.rdsCluster = new rds.DatabaseInstance(this, 'Postgres', {
      engine: rds.DatabaseInstanceEngine.postgres({ version: rds.PostgresEngineVersion.VER_16_2 }),
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.LARGE),
      credentials: rds.Credentials.fromSecret(dbCredentials),
      vpc: props.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroups: [props.rdsSg],
      allocatedStorage: 100,
      maxAllocatedStorage: 500, // auto-scale up to 500GB before action required
      storageType: rds.StorageType.GP3,
      storageEncrypted: true,
      storageEncryptionKey: props.kmsKey,
      backupRetention: cdk.Duration.days(7),
      deletionProtection: true,
      multiAz: false, // see cost trade-off in docstring
      enablePerformanceInsights: true,
      performanceInsightEncryptionKey: props.kmsKey,
      cloudwatchLogsExports: ['postgresql'],
      removalPolicy: cdk.RemovalPolicy.SNAPSHOT,
    });

    // ─── ElastiCache Redis (×2 clusters with different durability) ────────────
    //   1. App Redis: ephemeral cache, single node, OK to lose
    //   2. Session Redis: durable session store, multi-AZ failover
    //
    // Why two clusters not one: different durability + cost profiles.
    // Mixing ephemeral cache and durable sessions in one cluster means
    // either over-paying for cache durability or under-paying for sessions.
    const subnetGroup = new elasticache.CfnSubnetGroup(this, 'RedisSubnetGroup', {
      description: 'private isolated subnets for Redis',
      subnetIds: props.vpc.selectSubnets({ subnetType: ec2.SubnetType.PRIVATE_ISOLATED }).subnetIds,
    });

    this.appRedis = new elasticache.CfnReplicationGroup(this, 'AppRedis', {
      replicationGroupId: `${projectName}-prod-app`,
      replicationGroupDescription: 'app cache — single node, ephemeral',
      engine: 'redis',
      cacheNodeType: 'cache.t3.small',
      numCacheClusters: 1,
      cacheSubnetGroupName: subnetGroup.ref,
      securityGroupIds: [props.redisSg.securityGroupId],
      atRestEncryptionEnabled: true,
      transitEncryptionEnabled: true,
      kmsKeyId: props.kmsKey.keyArn,
      automaticFailoverEnabled: false,
    });

    this.sessionRedis = new elasticache.CfnReplicationGroup(this, 'SessionRedis', {
      replicationGroupId: `${projectName}-prod-session`,
      replicationGroupDescription: 'session store — multi-AZ, durable',
      engine: 'redis',
      cacheNodeType: 'cache.t3.micro',
      numCacheClusters: 2,
      multiAzEnabled: true,
      automaticFailoverEnabled: true,
      cacheSubnetGroupName: subnetGroup.ref,
      securityGroupIds: [props.redisSg.securityGroupId],
      atRestEncryptionEnabled: true,
      transitEncryptionEnabled: true,
      kmsKeyId: props.kmsKey.keyArn,
    });

    // ─── MSK Kafka ────────────────────────────────────────────────────────────
    // 3 brokers × kafka.t3.small × 100GB EBS each.
    // Why 3 brokers: minimum for replication factor 3 + min.insync.replicas=2.
    // That tolerates one broker failure without losing writes or availability.
    // Self-managed Kafka on EC2 is cheaper but operationally toxic (broker
    // upgrades, ZooKeeper coordination, monitoring) — MSK earns its premium.
    this.mskCluster = new msk.CfnCluster(this, 'Kafka', {
      clusterName: `${projectName}-prod-kafka`,
      kafkaVersion: '3.7.x',
      numberOfBrokerNodes: 3,
      brokerNodeGroupInfo: {
        instanceType: 'kafka.t3.small',
        clientSubnets: props.vpc.selectSubnets({ subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS }).subnetIds,
        securityGroups: [props.mskSg.securityGroupId],
        storageInfo: {
          ebsStorageInfo: { volumeSize: 100 },
        },
      },
      encryptionInfo: {
        encryptionAtRest: { dataVolumeKmsKeyId: props.kmsKey.keyArn },
        encryptionInTransit: { clientBroker: 'TLS', inCluster: true },
      },
      enhancedMonitoring: 'PER_TOPIC_PER_BROKER',
    });

    new cdk.CfnOutput(this, 'RdsEndpoint', { value: this.rdsCluster.dbInstanceEndpointAddress });
    new cdk.CfnOutput(this, 'AppRedisEndpoint', { value: this.appRedis.attrPrimaryEndPointAddress });
    new cdk.CfnOutput(this, 'MskClusterArn', { value: this.mskCluster.attrArn });
  }
}
