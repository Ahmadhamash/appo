import { randomUUID } from "node:crypto";

import { predictiveQueuePayloadSchema } from "@jormall/contracts/predictive";
import { getPredictiveRepository } from "@jormall/db/predictive-repository";
import { boundedExponentialBackoff } from "@jormall/domain/communications";
import { DomainError } from "@jormall/domain/errors";
import { Queue, Worker } from "bullmq";
import type { Job } from "bullmq";
import IORedis from "ioredis";

export const predictiveQueueName = "jormall-predictive";
const workerId = `predictive-${process.pid}-${randomUUID().slice(0, 8)}`;
const repository = getPredictiveRepository();

function connection(redisUrl: string): IORedis {
  return new IORedis(redisUrl, { maxRetriesPerRequest: null });
}

function log(record: Readonly<Record<string, string>>): void {
  process.stdout.write(`${JSON.stringify(record)}\n`);
}

function safeErrorCode(error: unknown): string {
  if (
    error instanceof DomainError &&
    ["MUTABLE_INPUT_RETRY_REQUIRES_NEW_JOB", "PARTIAL_EVIDENCE_ON_RETRY"].includes(
      String(error.metadata?.reason),
    )
  ) {
    return String(error.metadata?.reason);
  }
  return error instanceof DomainError ? error.code : "PREDICTIVE_WORKER_FAILURE";
}

export async function processPredictiveJob(job: Job): Promise<void> {
  const payload = predictiveQueuePayloadSchema.parse(job.data);
  try {
    await repository.processJob(payload.organizationId, payload.jobId, payload.leaseToken);
    log({
      event: "predictive.job.processed",
      jobId: payload.jobId,
      organizationId: payload.organizationId,
    });
  } catch (error) {
    const alreadyRunning =
      error instanceof DomainError &&
      error.code === "CONFLICT" &&
      error.metadata?.reason === "JOB_ALREADY_RUNNING";
    if (alreadyRunning) throw error;
    const authorizationEnded =
      error instanceof DomainError && ["FORBIDDEN", "NOT_FOUND"].includes(error.code);
    const failClosedRetry =
      error instanceof DomainError &&
      ["MUTABLE_INPUT_RETRY_REQUIRES_NEW_JOB", "PARTIAL_EVIDENCE_ON_RETRY"].includes(
        String(error.metadata?.reason),
      );
    const finalAttempt =
      authorizationEnded || failClosedRetry || job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
    const errorCode = safeErrorCode(error);
    await repository.markJobFailure(
      payload.organizationId,
      payload.jobId,
      errorCode,
      finalAttempt,
      payload.leaseToken,
    );
    log({
      errorCode,
      event: "predictive.job.failed",
      jobId: payload.jobId,
      organizationId: payload.organizationId,
    });
    if (!authorizationEnded && !failClosedRetry) throw error;
  }
}

export async function relayPredictiveJobsOnce(queue: Queue): Promise<number> {
  const claimed = await repository.claimPendingJobs(workerId);
  for (const job of claimed) {
    const queueJobId = `${job.id}-${job.leaseToken}`;
    const existing = await queue.getJob(queueJobId);
    if (existing) {
      const state = await existing.getState();
      const existingPayload = predictiveQueuePayloadSchema.safeParse(existing.data);
      const sameLease =
        existingPayload.success && existingPayload.data.leaseToken === job.leaseToken;
      if (sameLease && !["completed", "failed"].includes(state)) {
        await repository.markJobEnqueued(job.id, job.leaseToken);
        continue;
      }
      if (state === "active") continue;
      await existing.remove();
    }
    await queue.add(
      "process-predictive-job",
      {
        jobId: job.id,
        leaseToken: job.leaseToken,
        organizationId: job.organizationId,
        version: 1,
      },
      {
        attempts: 4,
        backoff: { delay: 1_000, type: "jormall-bounded" },
        jobId: queueJobId,
        removeOnComplete: 1_000,
        removeOnFail: 5_000,
      },
    );
    await repository.markJobEnqueued(job.id, job.leaseToken);
  }
  return claimed.length;
}

export async function startPredictiveWorker(redisUrl: string) {
  const queueConnection = connection(redisUrl);
  const workerConnection = connection(redisUrl);
  const queue = new Queue(predictiveQueueName, { connection: queueConnection });
  const worker = new Worker(predictiveQueueName, processPredictiveJob, {
    concurrency: 2,
    connection: workerConnection,
    lockDuration: 10 * 60_000,
    settings: {
      backoffStrategy(attemptsMade, type) {
        if (type !== "jormall-bounded") return -1;
        return boundedExponentialBackoff(attemptsMade);
      },
    },
  });
  const relayTimer = setInterval(() => {
    void relayPredictiveJobsOnce(queue).catch(() => {
      log({ errorCode: "PREDICTIVE_RELAY_FAILED", event: "predictive.relay.failed" });
    });
  }, 1_000);
  await relayPredictiveJobsOnce(queue);
  log({ event: "predictive.worker.ready" });

  return {
    async close() {
      clearInterval(relayTimer);
      await worker.close();
      await queue.close();
      await Promise.all([queueConnection.quit(), workerConnection.quit()]);
    },
    queue,
    worker,
  };
}
