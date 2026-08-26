import "server-only";

import { SharedAIChannelCoordinator } from "@jormall/ai/channels";
import { SafeActionGateway } from "@jormall/ai/gateway";
import { DeterministicMockModelAdapter } from "@jormall/ai/model";
import { SafeAIOrchestrator } from "@jormall/ai/orchestrator";

import { aiFoundationRepository } from "./identity";

const model = new DeterministicMockModelAdapter();
const gateway = new SafeActionGateway(aiFoundationRepository);
const orchestrator = new SafeAIOrchestrator(
  model,
  gateway,
  aiFoundationRepository,
  aiFoundationRepository,
);

export const aiChannelCoordinator = new SharedAIChannelCoordinator(
  orchestrator,
  aiFoundationRepository,
);
