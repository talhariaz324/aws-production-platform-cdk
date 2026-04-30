# Production Incidents — Forensic Walkthroughs

Three production incidents debugged and fixed on AWS. Each follows the same shape: **symptom → root cause → resolution → lessons**.

These are illustrative of the kinds of problems that arise running a real production stack on AWS — at the boundaries between services, where defaults that were sensible in isolation become hazards in context.

---

## Incident #1 — App stack deploy stuck in `UPDATE_ROLLBACK_FAILED`

### Symptom

- CloudFormation stuck in `UPDATE_IN_PROGRESS` for ~20 min during a CDK deploy
- Then `UPDATE_FAILED` on multiple ECS services
- Each with reason: `"ECS Deployment Circuit Breaker was triggered"`
- Stack went to `UPDATE_ROLLBACK_FAILED` — couldn't even roll back

### State at incident

- Some services rolled successfully (the simpler ones with no init-time work)
- Others stuck in `rollout=FAILED`
- A singleton service had `running=0` — task killed, can't start
- A brand-new service introduced in this deploy never started at all

### Root cause analysis

Two distinct problems compounded.

**Problem A: long-running `onModuleInit` blocked HTTP listener bind**

The singleton service's bootstrap looked roughly like:

```typescript
async onModuleInit() {
  for (const work of this.startupWork) {
    await this.processWork(work);  // ← awaited, blocking
  }
}
```

`processWork()` did real I/O — loaded a checkpoint, found state had drifted during the deploy window, and replayed inline. The replay took ~4 minutes. NestJS doesn't fire `app.listen(port)` until `onModuleInit` completes.

So:

- HTTP server never bound on the listening port
- ECS health check failed every 30s
- After `startPeriod=120s + 5 retries × 30s = 270s`, ECS killed the task
- New task started, same problem
- Circuit breaker fired after consecutive failures

**Problem B: ENI exhaustion on a small-instance ASG**

CDK config: `min: 1, max: 2` on a t3.small ASG. Services running on it: 4. Adding a new service made it 5.

ENI math:

- 2× t3.small × **3 ENIs each** (hard limit per instance class) = 6 ENIs
- Minus 2 host ENIs = 4 task slots
- 5th task = `RESOURCE:ENI` error
- The 4 already-running tasks then couldn't roll because `minimumHealthyPercent=100` requires the new task to start before the old stops, and there was no spare ENI

### Resolution (in order)

1. **Patched the long-running init** by adding `healthCheckStartPeriodSeconds: 300` (AWS max) to the affected services. Buys 5 min for replay before health check kills the task. *Real fix* (filed as backlog): refactor to fire the long-running work async after `app.listen`.
2. **Bumped ASG capacity**: `min: 1, max: 2` → `min: 2, max: 3`. Now 6 task slots = 5 tasks + 1 spare ENI.
3. **Recovered the stuck stack**: manually patched the broken task definitions, force-redeployed, then:
   ```bash
   aws cloudformation continue-update-rollback \
     --stack-name <Stack> \
     --resources-to-skip Svc<each-stuck-service>
   ```
4. **Re-deployed cleanly** with the new CDK changes baked in. UPDATE_COMPLETE in ~25 min.

### Lessons learned

1. **Long `onModuleInit` is a deploy hazard.** If init takes >2 min, fire it async after `app.listen`. Failing health checks before the HTTP server binds = death by health-check loop.
2. **ENI math is non-negotiable.** Plan ASG capacity = `(N services + 1 spare) / (instance ENI limit − 1 for host)`. `t3.small` has 3 ENIs → 2 task slots per host. There's no override.
3. **`continue-update-rollback --resources-to-skip`** is the escape hatch for stuck rollbacks once you've fixed the underlying state manually. Worth having in your runbook.
4. **Always test CDK changes against staging first.** A staging environment that mirrors prod's compute layout catches ENI-math errors before they bite production.

---

## Incident #2 — Cross-region S3 replication for KMS-encrypted objects

### Symptom

- Replication enabled for an SSE-S3 backups bucket: worked immediately
- Replication enabled for a KMS-encrypted uploads bucket: error
  ```
  ReplicaKmsKeyID must be specified if SseKmsEncryptedObjects tag is present
  ```

### Root cause

Cross-region replication of KMS-encrypted objects is a **3-way IAM dance**:

1. Source IAM role needs `kms:Decrypt` on the **source** key (with `kms:ViaService` condition for `s3.<source-region>.amazonaws.com`)
2. Replication config must explicitly name the **destination** KMS key
3. Source IAM role needs `kms:Encrypt` and `kms:GenerateDataKey` on the **destination** key (with `kms:ViaService` for `s3.<dest-region>.amazonaws.com`)
4. Destination bucket must have KMS encryption configured to use that destination key

We had #1 (added earlier for migration tooling). Missing #2, #3, #4.

### Resolution

1. Configured destination bucket encryption to use the multi-region KMS replica key (same key ID, different region ARN)
2. Updated replication config to specify `EncryptionConfiguration.ReplicaKmsKeyID`
3. Extended replication-role IAM policy with `kms:Encrypt` + `kms:GenerateDataKey` on the destination key, gated by `kms:ViaService`
4. Re-applied replication config; smoke-tested with a small object → appeared in dest within ~30s

### Lessons learned

- **Cross-region KMS replication is not "set and forget."** The IAM grant chain crosses region boundaries via `kms:ViaService` conditions; mis-scope it and replication silently 403s.
- **Multi-region KMS keys** save the alternative pain (managing two separate keys with parallel rotation schedules). Same key ID, different ARN region.
- **AWS error messages here are unusually clear.** Read them literally — `ReplicaKmsKeyID must be specified` actually means exactly that.

---

## Incident #3 — CloudFront 403 after upstream change

### Symptom

After removing an upstream worker that was rewriting headers between client and CloudFront, the public landing page started returning 403 from CloudFront.

### Root cause

The worker had been injecting an `Origin` header that CloudFront's behavior expected. Removing the worker meant the request hit CloudFront without that header, the OAI-restricted S3 origin saw an unsigned request, and S3 returned 403, which CloudFront passed through.

The deeper issue: **CloudFront caches error responses too**. The 403 was cached for 5 minutes by default. Even after fixing the origin, users saw the stale 403 for 5 min.

### Resolution

1. Reconfigured CloudFront to forward the right headers without the worker
2. **Invalidated the CloudFront cache** for the affected paths — without invalidation, the error TTL would have prolonged the outage
3. Added explicit `errorResponses` rules to the CDK distribution with TTLs tuned to the error type (longer for genuine 404s, shorter for transient origin errors)

### Lessons learned

- **Test in CloudFront, not just at origin.** A working S3 origin doesn't mean a working CloudFront response — headers, OAI signatures, cache TTLs, behaviors all participate in the response.
- **CloudFront caches error responses.** Default 5-min error TTL is fine for content not-found; it's punishing for transient origin problems.
- **Cache invalidation belongs in your rollback playbook.** If your rollback doesn't include `aws cloudfront create-invalidation`, the rollback hasn't actually rolled back for users.

---

## What these incidents have in common

1. **Layer interactions** — every incident sits at a boundary between two AWS services (ECS ↔ ENI, S3 ↔ KMS ↔ IAM, CloudFront ↔ S3). The bug is rarely in one service; it's in the contract between them.
2. **Defaults that bite at scale** — health-check timeouts, ENI limits, cache TTLs, KMS condition keys. Each was sensible for the original design point but failed in the new context without explicit configuration.
3. **CDK is leverage, not magic** — these problems would have happened with click-ops or Terraform too. CDK's value is making the resolution reproducible and reviewable, not preventing the design errors.

The takeaway for any team running on AWS: **read the docs on the boundary, not the docs on the service.**
