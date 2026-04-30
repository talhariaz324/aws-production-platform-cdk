import * as cdk from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cwActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as snsSub from 'aws-cdk-lib/aws-sns-subscriptions';
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';

export interface ObservabilityStackProps extends cdk.StackProps {
  projectName: string;
  alertEmail: string;
  rdsInstanceIdentifier: string;
}

/**
 * Observability + WAF.
 * CloudWatch over Datadog/New Relic at small-team scale: a $200/mo Datadog
 * tier is hard to justify when CloudWatch + Performance Insights cover
 * most of the same ground. Revisit at 10x scale or when distributed
 * tracing becomes critical to MTTR.
 */
export class ObservabilityStack extends cdk.Stack {
  public readonly alertTopic: sns.Topic;

  constructor(scope: Construct, id: string, props: ObservabilityStackProps) {
    super(scope, id, props);

    const { projectName } = props;

    // ─── SNS topic for alerts ─────────────────────────────────────────────────
    this.alertTopic = new sns.Topic(this, 'AlertTopic', {
      topicName: `${projectName}-prod-alerts`,
      displayName: `${projectName} prod alerts`,
    });
    this.alertTopic.addSubscription(new snsSub.EmailSubscription(props.alertEmail));

    // ─── Critical alarms ──────────────────────────────────────────────────────
    const addAlarm = (
      id: string,
      name: string,
      metric: cloudwatch.IMetric,
      threshold: number,
      comparison: cloudwatch.ComparisonOperator,
      evalPeriods = 2,
    ): cloudwatch.Alarm => {
      const alarm = new cloudwatch.Alarm(this, id, {
        alarmName: `${projectName}-${name}`,
        metric,
        threshold,
        comparisonOperator: comparison,
        evaluationPeriods: evalPeriods,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      });
      alarm.addAlarmAction(new cwActions.SnsAction(this.alertTopic));
      return alarm;
    };

    // RDS — running out of space is silent until it isn't
    addAlarm(
      'RdsLowStorage',
      'rds-low-storage',
      new cloudwatch.Metric({
        namespace: 'AWS/RDS',
        metricName: 'FreeStorageSpace',
        dimensionsMap: { DBInstanceIdentifier: props.rdsInstanceIdentifier },
        statistic: 'Average',
        period: cdk.Duration.minutes(5),
      }),
      20 * 1024 * 1024 * 1024, // 20 GB
      cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
    );

    addAlarm(
      'RdsHighCpu',
      'rds-cpu-high',
      new cloudwatch.Metric({
        namespace: 'AWS/RDS',
        metricName: 'CPUUtilization',
        dimensionsMap: { DBInstanceIdentifier: props.rdsInstanceIdentifier },
        statistic: 'Average',
        period: cdk.Duration.minutes(5),
      }),
      80,
      cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      6, // sustained 30 min — short spikes are normal
    );

    // ─── WAF (regional, attaches to ALB) ──────────────────────────────────────
    new wafv2.CfnWebACL(this, 'WebAcl', {
      name: `${projectName}-prod-web-acl`,
      scope: 'REGIONAL',
      defaultAction: { allow: {} },
      rules: [
        {
          name: 'AWSManagedRulesCommonRuleSet',
          priority: 1,
          statement: {
            managedRuleGroupStatement: { vendorName: 'AWS', name: 'AWSManagedRulesCommonRuleSet' },
          },
          overrideAction: { none: {} },
          visibilityConfig: {
            sampledRequestsEnabled: true,
            cloudWatchMetricsEnabled: true,
            metricName: 'common-rules',
          },
        },
        {
          name: 'AWSManagedRulesKnownBadInputsRuleSet',
          priority: 2,
          statement: {
            managedRuleGroupStatement: { vendorName: 'AWS', name: 'AWSManagedRulesKnownBadInputsRuleSet' },
          },
          overrideAction: { none: {} },
          visibilityConfig: {
            sampledRequestsEnabled: true,
            cloudWatchMetricsEnabled: true,
            metricName: 'bad-inputs',
          },
        },
        {
          name: 'rate-limit',
          priority: 10,
          statement: {
            rateBasedStatement: {
              limit: 2000, // requests per 5 min per IP
              aggregateKeyType: 'IP',
            },
          },
          action: { block: {} },
          visibilityConfig: {
            sampledRequestsEnabled: true,
            cloudWatchMetricsEnabled: true,
            metricName: 'rate-limit',
          },
        },
      ],
      visibilityConfig: {
        sampledRequestsEnabled: true,
        cloudWatchMetricsEnabled: true,
        metricName: `${projectName}-prod-acl`,
      },
    });

    // ─── Log groups with retention ────────────────────────────────────────────
    // Default CloudWatch log retention is "never expire" — that's how a $5/mo
    // logs bill becomes $200/mo over a year. Explicit retention is required.
    new logs.LogGroup(this, 'EcsCoreLogs', {
      logGroupName: `/ecs/${projectName}-prod/core`,
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    new cdk.CfnOutput(this, 'AlertTopicArn', { value: this.alertTopic.topicArn });
  }
}
