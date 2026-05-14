import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as autoscaling from 'aws-cdk-lib/aws-autoscaling';
import { Construct } from 'constructs';

export interface AppStackProps extends cdk.StackProps {
  projectName: string;
  stage: string;
  vpc: ec2.IVpc;
  albSg: ec2.ISecurityGroup;
  ecsSg: ec2.ISecurityGroup;
}

/**
 * App tier: ECS on EC2 with capacity providers split by workload class.
 *
 * Why multiple ASGs instead of one:
 *   - "core" hosts the regular fleet of stateless API services
 *   - "supporting" hosts auxiliary work (compliance, reporting, batch jobs)
 *   - "singleton" hosts services that MUST run as exactly one task
 *     (custodial wallet, exactly-once event consumer, etc.)
 *
 * The singleton ASGs are scaled to maxSize=1 so ECS cannot accidentally
 * place two copies of these tasks during a rolling deploy. The cost
 * (a dedicated t3.small per singleton) is the price of correctness for
 * services that MUST NOT run two copies — e.g. anything with at-most-once
 * semantics, exclusive locks, or financial state.
 */
export class AppStack extends cdk.Stack {
  public readonly cluster: ecs.Cluster;
  public readonly alb: elbv2.ApplicationLoadBalancer;

  constructor(scope: Construct, id: string, props: AppStackProps) {
    super(scope, id, props);

    const { projectName, stage } = props;

    // ─── ECR repos for service images ─────────────────────────────────────────
    // Sample backend service set — adjust to your actual services.
    const services = [
      'api-gateway',
      'auth',
      'accounts',
      'payments',
      'ledger',
      'notification',
      'compliance',
      'reporting',
    ];
    for (const svc of services) {
      new ecr.Repository(this, `${svc}Repo`, {
        repositoryName: `${projectName}-${stage}/${svc}`,
        imageScanOnPush: true,
        lifecycleRules: [
          { description: 'keep last 10 images', maxImageCount: 10 },
          {
            description: 'expire untagged after 7d',
            maxImageAge: cdk.Duration.days(7),
            tagStatus: ecr.TagStatus.UNTAGGED,
          },
        ],
        removalPolicy: cdk.RemovalPolicy.RETAIN,
      });
    }

    // ─── ECS Cluster ──────────────────────────────────────────────────────────
    // containerInsightsV2 supersedes the boolean `containerInsights` flag.
    // ENABLED gives standard Container Insights metrics; ENHANCED adds
    // per-task / per-container granularity at a higher CloudWatch cost.
    // ENABLED is the right baseline — flip to ENHANCED only when you need
    // task-level CPU / memory attribution to chase a specific issue.
    this.cluster = new ecs.Cluster(this, 'Cluster', {
      clusterName: `${projectName}-${stage}`,
      vpc: props.vpc,
      containerInsightsV2: ecs.ContainerInsights.ENABLED,
    });

    // ─── Capacity Providers ───────────────────────────────────────────────────
    const buildAsg = (id: string, opts: { min: number; max: number; instanceType: ec2.InstanceType }) => {
      return new autoscaling.AutoScalingGroup(this, id, {
        vpc: props.vpc,
        vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
        instanceType: opts.instanceType,
        machineImage: ecs.EcsOptimizedImage.amazonLinux2(),
        minCapacity: opts.min,
        maxCapacity: opts.max,
        securityGroup: props.ecsSg,
        // On-Demand only — Spot would save ~60% but services need graceful
        // SIGTERM handling first to handle the 2-min termination notice.
        // See docs/cost-optimization.md "deferred levers".
      });
    };

    // ENI math reminder: t3.small has a hard limit of 3 ENIs. With one
    // reserved for the host, that's 2 task slots per instance. Plan ASG
    // capacity = (services + spare) / (eni_limit - 1).
    const coreAsg = buildAsg('CoreAsg', {
      min: 2,
      max: 6,
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.MEDIUM),
    });
    const supportingAsg = buildAsg('SupportingAsg', {
      min: 2,
      max: 5,
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.SMALL),
    });
    const singletonAsg = buildAsg('SingletonAsg', {
      min: 1,
      max: 1, // exactly one — never let ECS run two copies
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.SMALL),
    });

    const coreCp = new ecs.AsgCapacityProvider(this, 'CoreCp', {
      autoScalingGroup: coreAsg,
      capacityProviderName: 'core',
      enableManagedTerminationProtection: true,
      enableManagedScaling: true,
    });
    const supportingCp = new ecs.AsgCapacityProvider(this, 'SupportingCp', {
      autoScalingGroup: supportingAsg,
      capacityProviderName: 'supporting',
      enableManagedTerminationProtection: true,
      enableManagedScaling: true,
    });
    const singletonCp = new ecs.AsgCapacityProvider(this, 'SingletonCp', {
      autoScalingGroup: singletonAsg,
      capacityProviderName: 'singleton',
      enableManagedTerminationProtection: true,
      enableManagedScaling: true,
    });

    this.cluster.addAsgCapacityProvider(coreCp);
    this.cluster.addAsgCapacityProvider(supportingCp);
    this.cluster.addAsgCapacityProvider(singletonCp);

    // ─── ALB ──────────────────────────────────────────────────────────────────
    this.alb = new elbv2.ApplicationLoadBalancer(this, 'Alb', {
      vpc: props.vpc,
      internetFacing: true,
      securityGroup: props.albSg,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
    });

    // HTTP redirect → HTTPS (ACM cert added via separate stack referencing this)
    this.alb.addListener('HttpListener', {
      port: 80,
      defaultAction: elbv2.ListenerAction.redirect({
        protocol: 'HTTPS',
        port: '443',
        permanent: true,
      }),
    });

    // ECS task execution role — pulled by ECS to fetch images, write logs,
    // fetch secrets at task start.
    new iam.Role(this, 'EcsTaskExecutionRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonECSTaskExecutionRolePolicy'),
      ],
    });

    new cdk.CfnOutput(this, 'AlbDns', { value: this.alb.loadBalancerDnsName });
    new cdk.CfnOutput(this, 'ClusterName', { value: this.cluster.clusterName });
  }
}
