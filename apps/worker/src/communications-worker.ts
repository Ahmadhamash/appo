import { randomUUID } from "node:crypto";

import { communicationQueuePayloadSchema } from "@jormall/contracts/communications";
import { prisma } from "@jormall/db/client";
import { CommunicationRepository } from "@jormall/db/communication-repository";
import {
  boundedExponentialBackoff,
  LocalMockProviderAdapter,
  safeCommunicationLog,
} from "@jormall/domain/communications";
import { TelephonyAdapterError } from "@jormall/domain/ai-channels";
import { DomainError } from "@jormall/domain/errors";
import { Queue, Worker } from "bullmq";
import type { Job } from "bullmq";
import IORedis from "ioredis";

import { processAIChannelEvent } from "./ai-channel-worker";

export const communicationsQueueName = "jormall-communications";
const workerId = `communications-${process.pid}-${randomUUID().slice(0, 8)}`;
const repository = new CommunicationRepository(prisma);
const adapters = new Map([
  ["MOCK_SMS", new LocalMockProviderAdapter("MOCK_SMS")],
  ["MOCK_WHATSAPP", new LocalMockProviderAdapter("MOCK_WHATSAPP")],
]);

function log(record: Readonly<Record<string, string>>): void {
  process.stdout.write(`${JSON.stringify(record)}\n`);
}

export function createRedisConnection(redisUrl: string): IORedis {
  return new IORedis(redisUrl, { maxRetriesPerRequest: null });
}

export async function processCommunicationJob(job: Job): Promise<void> {
  const payload = communicationQueuePayloadSchema.parse(job.data);
  try {
    const work = await repository.getOutboxWorkState(payload.organizationId, payload.outboxEventId);
    if (work.processed) return;
    const outcome = work.eventType.startsWith("AI_")
      ? await processAIChannelEvent(
          payload.organizationId,
          payload.outboxEventId,
          work.eventType,
        ).then(() => "processed" as const)
      : await repository.processOutboxEvent(
          payload.organizationId,
          payload.outboxEventId,
          adapters,
        );
    if (outcome === "retry") {
      throw new Error("RETRYABLE_PROVIDER_FAILURE");
    }
    await repository.heartbeat(workerId, "healthy", "processed");
    log(
      safeCommunicationLog({
        event: "communication.job.processed",
        organizationId: payload.organizationId,
        outboxEventId: payload.outboxEventId,
      }),
    );
  } catch (error) {
    const permanentTelephonyFailure = error instanceof TelephonyAdapterError && !error.retryable;
    const finalAttempt =
      permanentTelephonyFailure || job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
    const errorCode =
      error instanceof DomainError
        ? error.code
        : error instanceof TelephonyAdapterError
          ? error.code
          : "WORKER_ATTEMPTS_EXHAUSTED";
    if (finalAttempt) {
      await repository.deadLetterOutbox(payload.organizationId, payload.outboxEventId, errorCode);
    }
    await repository.heartbeat(workerId, "degraded", "failed");
    log(
      safeCommunicationLog({
        errorCode:
          error instanceof DomainError
            ? error.code
            : error instanceof TelephonyAdapterError
              ? error.code
              : error instanceof Error && error.message === "RETRYABLE_PROVIDER_FAILURE"
                ? "RETRYABLE_PROVIDER_FAILURE"
                : "UNEXPECTED_JOB_ERROR",
        event: "communication.job.failed",
        organizationId: payload.organizationId,
        outboxEventId: payload.outboxEventId,
      }),
    );
    if (permanentTelephonyFailure) return;
    throw error;
  }
}

export async function relayOutboxOnce(queue: Queue): Promise<number> {
  const claimed = await repository.claimOutboxEvents(workerId);
  for (const event of claimed) {
    await queue.add(
      "process-outbox-event",
      { organizationId: event.organizationId, outboxEventId: event.id, version: 1 },
      {
        attempts: 4,
        backoff: { delay: 1_000, type: "jormall-bounded" },
        jobId: event.id,
        removeOnComplete: 1_000,
        removeOnFail: 5_000,
      },
    );
    await repository.markOutboxEnqueued(event.id);
  }
  return claimed.length;
}

export async function startCommunicationsWorker(redisUrl: string) {
  const queueConnection = createRedisConnection(redisUrl);
  const workerConnection = createRedisConnection(redisUrl);
  const queue = new Queue(communicationsQueueName, { connection: queueConnection });
  const worker = new Worker(communicationsQueueName, processCommunicationJob, {
    concurrency: 8,
    connection: workerConnection,
    settings: {
      backoffStrategy(attemptsMade, type) {
        if (type !== "jormall-bounded") return -1;
        return boundedExponentialBackoff(attemptsMade);
      },
    },
  });
  const relayTimer = setInterval(() => {
    void relayOutboxOnce(queue).catch(() => {
      log(
        safeCommunicationLog({
          errorCode: "OUTBOX_RELAY_FAILED",
          event: "communication.relay.failed",
        }),
      );
    });
  }, 500);
  const heartbeatTimer = setInterval(() => {
    void repository.heartbeat(workerId, "healthy");
  }, 10_000);
  await repository.heartbeat(workerId, "healthy");
  await relayOutboxOnce(queue);
  log(safeCommunicationLog({ event: "communications.worker.ready" }));

  return {
    async close() {
      clearInterval(relayTimer);
      clearInterval(heartbeatTimer);
      await repository.heartbeat(workerId, "stopped");
      await worker.close();
      await queue.close();
      await Promise.all([queueConnection.quit(), workerConnection.quit()]);
      await prisma.$disconnect();
    },
    queue,
    worker,
  };
}
