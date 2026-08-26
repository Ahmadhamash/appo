import { parseWorkerEnvironment } from "@jormall/config/environment";

import { startCommunicationsWorker } from "./communications-worker";
import { startPredictiveWorker } from "./predictive-worker";

const environment = parseWorkerEnvironment({
  DATABASE_URL: process.env.DATABASE_URL,
  REDIS_URL: process.env.REDIS_URL,
});

const communications = await startCommunicationsWorker(environment.REDIS_URL);
const predictive = await startPredictiveWorker(environment.REDIS_URL);
let closing = false;
async function close(): Promise<void> {
  if (closing) return;
  closing = true;
  await predictive.close();
  await communications.close();
}
process.once("SIGINT", () => void close());
process.once("SIGTERM", () => void close());
