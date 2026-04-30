# Interview Defense — Common Questions, Direct Answers

A senior interviewer's job is to push on every choice. Here's how each architectural decision in this blueprint defends.

---

### Q: "Walk me through the architecture in 60 seconds"

User → CloudFront → ALB → ECS (capacity providers split by workload class) → RDS Postgres + ElastiCache Redis ×2 + MSK Kafka. All inside a 2-AZ VPC with private app subnets and isolated data subnets. NAT × 2 for egress, VPC endpoints for AWS API traffic. KMS for at-rest encryption everywhere. GitHub Actions deploys via OIDC role — no stored AWS keys. CloudWatch + Performance Insights for observability. ~$830-940/mo at small-team scale, sub-linear scaling to ~$1,800 at 10×.

---

### Q: "Why ECS, not EKS?"

EKS pays off when you have many services and a platform team to amortize the operational cost (managed control plane fee + cluster autoscaler + ingress controller + RBAC + observability stack). At fewer services, EKS adds complexity without proportional value. ECS gives me task placement, capacity providers, service discovery via Cloud Map, and rolling deploys out of the box. The day there's a platform team, EKS becomes attractive — until then, ECS is the right scope.

---

### Q: "Why ECS on EC2 instead of Fargate?"

Fargate is right when workloads are bursty or short-lived — you don't want to pay for hosts that sit idle. For a steady-state production stack, Fargate costs ~30% more than equivalent ECS-on-EC2 because you're paying the abstraction premium on every CPU-second. The capacity provider model on EC2 also lets me size ASGs by workload class (core / supporting / singleton), which Fargate's per-task billing doesn't naturally support.

---

### Q: "Why Single-AZ RDS in production?"

Pre-revenue cash burn. Multi-AZ doubles the RDS line item — that's significant annual money on a feature that prevents a 5–15 minute outage during an AZ failure (which has roughly 0.1% annual probability per AZ). Pre-launch, the math doesn't work. The trigger to flip Multi-AZ on is "first revenue cohort" or "AZ failure costs more than the standby."

I documented the trade-off in CDK code comments so the next person reading doesn't think it's an oversight.

---

### Q: "How do you handle a region failure?"

Today: degrade gracefully, restore in us-west-2 from cross-region replicated S3 backups + the most recent RDS snapshot copied via AWS Backup vault. RTO ~2-4 hours, RPO ~1 hour.

Not Netflix-grade. We don't run active-active or warm standby because at this scale, region failure is rare enough that the always-on cost (~$800/mo for a warm us-west-2 mirror) doesn't pay back. The trade-off is documented; the trigger to add warm standby is when revenue covers the recurring cost or a contract requires tighter RTO.

---

### Q: "Tell me about a hard problem you solved on AWS"

(See `docs/incidents.md` for full forensics.)

Short version: an ECS deploy got stuck in `UPDATE_ROLLBACK_FAILED` from two compounding causes. One was a service whose `onModuleInit` did 4 minutes of synchronous I/O before `app.listen()` could bind, so health checks failed before the HTTP server was ready — death by health-check loop. The other was ENI exhaustion on a t3.small ASG (hard limit of 3 ENIs per instance, which we'd silently outgrown). Recovery required `cloudformation continue-update-rollback --resources-to-skip` after manually patching the broken task definitions.

The lesson: **most AWS incidents live at the boundary between services, not inside one service**. The fix was CDK changes (start-period grace, ASG sizing math) — but the *discovery* required reading the boundary contract (ECS health check semantics × NestJS lifecycle × ENI per-instance limits).

---

### Q: "How do you ensure data durability?"

Five layers, all running:

1. RDS automated backups, 7-day retention, point-in-time recovery
2. AWS Backup vault: weekly snapshots / 90-day, monthly / 1-year
3. Logical `pg_dump` daily via Fargate task → S3 (protects against logical corruption that snapshots can't fix)
4. S3 cross-region replication of backup bucket (us-east-1 → us-west-2)
5. Glacier transition on backup bucket after 30 days

Layers 1–2 protect against AWS infra failure. Layer 3 against logical corruption. Layer 4 against region failure. Layer 5 manages cost.

Restore drill: documented procedure for each layer, tested quarterly.

---

### Q: "Why a single AWS account?"

Multi-account is correct at scale (separation of dev/staging/prod blast radius, security account for centralized CloudTrail). It's the wrong answer at 1 engineer + few services pre-revenue, because:

- AWS Organizations + multiple accounts adds CDK pipeline complexity (cross-account roles, asset bucket per account, OIDC per account)
- Blast-radius gain over "one account with strict IAM + production resource policies" is marginal pre-revenue
- SOC 2 audit will eventually require account separation; that's the trigger

We use IAM least-privilege within the account. Multi-account is on the post-launch list with "first SOC 2 conversation" as the trigger.

---

### Q: "Why MSK and not SNS+SQS or EventBridge?"

MSK gives three properties the AWS-native messaging stack doesn't:

1. **Replayability**: Kafka is a durable log. New consumers can rebuild state by consuming from offset 0. With SQS, the message is gone after ack.
2. **Per-key ordering**: partitioning by aggregate ID means all events for one aggregate land on the same partition, processed in order even with many parallel consumers. SQS FIFO is per-queue and throughput-limited.
3. **Multiple independent consumers** reading the same data via consumer groups, each with its own offset. SNS fan-out works but loses replay.

The cost is operational complexity. MSK is significant ongoing cost and requires understanding Kafka tuning (RF, min.insync.replicas, partition count). For workloads — financial events that benefit from a durable audit log and downstream replay — it's the right tool.

---

### Q: "Where would you change the architecture if you had 10× the budget?"

In priority order:

1. **Multi-AZ RDS** + Multi-AZ ElastiCache app cluster — cheapest availability win
2. **Pre-deployed warm standby in us-west-2** — cuts DR RTO from 4hr to ~30 min
3. **Datadog or Honeycomb** — distributed tracing across many services pays for itself in MTTR
4. **Aurora Postgres** instead of RDS — better at scale (read replicas without storage duplication, faster failover)
5. **Spot instances** for ECS hosts behind interrupt-tolerant services (services need graceful SIGTERM handling first)

Notice what's NOT on this list: EKS, service mesh, multi-account day-one. Those are scale problems, not money problems.

---

### Q: "What's the biggest weakness of this architecture today?"

Two things, both honest:

1. **Limited staging mirror of the App stack.** It's expensive to run a full duplicate. The compromise: synth checks in CI catch most CDK errors, and a smaller staging environment for the application layer catches most app errors. The gap: I don't catch ENI-math errors at the boundary until production.

2. **Observability gap on Kafka consumer lag.** I have CloudWatch alarms on RDS, ALB 5xx, and disk space. I don't yet have an alarm on Kafka consumer lag per consumer group. If a consumer falls behind silently, the first signal is a user complaint. Fix is straightforward: emit lag metric to CloudWatch + alarm — just hadn't been done at launch.

Both are documented in the post-launch backlog. Neither is a design error; both are work-not-yet-done.
