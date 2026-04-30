# Cost Optimization Playbook

What a production fintech AWS bill looks like at small-team scale, and where the levers are. Numbers are illustrative for a comparable workload — your bill will track yours, not these.

## Illustrative monthly snapshot (small-team production)

```
COMPUTE                                                   ~$180-200
  ECS Core ASG (2× t3.medium On-Demand)                       ~$60
  ECS Supporting ASG (2-3× t3.small)                       ~$30-45
  ECS Singleton ASGs (1× t3.small × N singletons)         ~$15/each
  Fargate (one-shot batch tasks, e.g. nightly pg_dump)         ~$1
  EC2 Staging instance (1× t3.large, public)                  ~$60

DATABASE                                                      ~$150
  RDS PostgreSQL (db.t3.large, 100GB gp3, Single-AZ)         ~$150

CACHE                                                          ~$45
  App Redis (cache.t3.small × 1)                              ~$25
  Session Redis (cache.t3.micro × 2 Multi-AZ)                 ~$20

EVENT STREAMING                                               ~$240
  MSK (3× kafka.t3.small + 100GB EBS each)                   ~$240

NETWORKING                                                ~$150-170
  NAT Gateway × 2 (cross-AZ)                                  ~$66
  ALB                                                         ~$20
  Data transfer (NAT egress + ALB egress)                  ~$30-50
  VPC Endpoints (5 interface)                                 ~$36

STORAGE & DELIVERY                                          ~$15-30
  S3 (uploads + backups + cloudtrail + frontend buckets)   ~$5-15
  S3 cross-region replication                              ~$5-10
  CloudFront (mostly within free tier at low traffic)       ~$0-5

SECURITY                                                       ~$15
  WAF                                                         ~$10
  KMS (custom key, multi-region replica)                       ~$2
  Secrets Manager (~2 secrets)                                  ~$1
  CloudTrail                                                    ~$2

BACKUP                                                      ~$15-30
  RDS automated backup storage (7-day retention)            ~$5-10
  AWS Backup vault (weekly + monthly retention)            ~$10-20
  S3 backup bucket + Glacier transition                      ~$1-3

OBSERVABILITY                                               ~$15-25
  CloudWatch (logs, metrics, alarms)                       ~$10-20
  RDS Performance Insights                                 included
  VPC Flow Logs (S3 storage)                                    ~$5

TOTAL                                                    ~$830-940/mo
```

This is what a 10-service production stack tends to cost at small-team scale. At larger scale most line items grow sub-linearly because the shared resources (RDS, MSK, Redis, ALB) absorb traffic without proportional cost increases.

## What's already optimized vs. naive choices

| Optimization | Saves | Cost |
|---|---|---|
| **VPC Endpoints (5 interface + S3 gateway)** | ~$120/mo NAT egress | +$36/mo endpoints. **Net positive.** |
| **CloudFront PriceClass 100** (US/EU only, not global) | ~30% on egress | None — irrelevant if your users aren't in APAC/SA. |
| **gp3 RDS storage** instead of gp2 | ~20% on storage IOPS at our size | None — gp3 strictly better than gp2. |
| **Single-AZ RDS** at launch | ~$150/mo | Higher RTO on AZ failure (5–15 min vs. <60s). Acceptable pre-revenue. |
| **CloudWatch over Datadog** | ~$180/mo | Less polished UX. Revisit at 10x scale. |
| **No Reserved Instances yet** | $0 saved | But also $0 committed. Architecture unstable; commit-now = stranded capacity later. |
| **Spot NOT used for ECS** | $0 saved | Would save ~$60/mo on compute, but services aren't yet interrupt-tolerant. |
| **CloudWatch log retention forced to 1 month** | ~$50+/mo over a year | Default "never expire" is the silent killer of small AWS bills. |

## Deferred levers (with concrete triggers)

### Spot for ECS hosts (~60% off compute)
- **Blocker**: services don't yet handle the 2-minute Spot termination notice gracefully.
- **Trigger**: when SIGTERM handling lands across the service template + drain hooks tested in staging.
- **Risk**: a misbehaving service that dies hard during termination = 2-min request loss per Spot reclamation.

### Reserved Instances / Savings Plans
- Compute Savings Plan (1yr, all upfront): ~30% off EC2.
- RDS Reserved Instance (1yr, all upfront): ~35% off RDS.
- **Trigger**: architecture stable for 6+ months. Locking in db.t3.large then upgrading later strands the RI premium.

### Aurora PostgreSQL
- **Cost**: ~50% more per hour than RDS Postgres at small size, but storage auto-scales without provisioning, failover is faster (<60s), read replicas don't duplicate storage.
- **Trigger**: when read load justifies replicas. RDS replicas duplicate storage; Aurora doesn't.

### Multi-AZ RDS
- **Cost**: roughly doubles the RDS line item.
- **Trigger**: revenue threshold OR when AZ failure costs more than the standby. Pre-revenue, the recurring cost outweighs the rare event.

### MSK Provisioned → MSK Serverless
- MSK Serverless charges per partition-hour and throughput. Cheaper at low traffic, more expensive at high steady-state.
- **Decision rule**: <50% broker utilization sustained for a month → switch to Serverless.

## Cost projections

### At 10× user growth (~$1,500–1,800/mo)

| Component | Today | At 10x | Why |
|---|---|---|---|
| ECS hosts | ~$135 | ~$300 | Core scales 2→4, supporting 3→5 |
| RDS | ~$150 | ~$300 | Move to db.m5.large + Multi-AZ |
| ElastiCache | ~$45 | ~$60 | App Redis grows |
| MSK | ~$240 | ~$240 | 3 brokers handle 10x throughput at this partition count |
| NAT egress | ~$30 | ~$200 | Inter-AZ + internet egress dominates |
| S3 + CRR | ~$20 | ~$80 | More user uploads |
| CloudWatch + WAF | ~$40 | ~$80 | More logs |

**Sub-linear scaling.** Doubling traffic doesn't double the bill — most line items have headroom. This is the architectural pay-off for shared resources (one DB, one Kafka, one Redis cluster) over per-service provisioning.

### At 100× (~$6,000+/mo)

NAT egress becomes the dominant line item. Mitigations: VPC peering for known internal endpoints, Transit Gateway for hub-and-spoke. Aurora replaces RDS. Reserved capacity commits become rational.

## Anti-patterns deliberately avoided

- **Lambda for everything.** Tempting at small scale, but cold starts are real, costs sprawl with traffic, debugging is harder. Long-running services on ECS are predictable.
- **Multi-account from day one.** AWS Organizations + dev/staging/prod/security accounts adds CDK pipeline complexity for marginal blast-radius gain pre-revenue. Single account with strict IAM is fine until SOC 2.
- **3 AZs for "high availability."** Adds a third NAT (~$33/mo) and three-way replica costs for marginal availability over 2 AZs. ALB + ECS + RDS Single-AZ on 2 AZs has acceptable failure domain pre-revenue.
- **EKS instead of ECS.** Kubernetes pays off when you have 50+ services and a platform team. At small scale, EKS control plane fees + operator burden exceeds ECS by a wide margin.
- **Per-resource KMS keys.** "Blast radius isolation" sounds good but in practice means coordinated key rotation across services. One CMK with strict IAM is the right scope for most threat models.

## The single most expensive lesson

**CloudWatch log retention defaults to "never expire."** A modest service producing 50MB/day of logs becomes ~18GB after a year. Multiply by N services. The bill compounds silently.

Always set `RetentionDays` explicitly on every log group. Always.
