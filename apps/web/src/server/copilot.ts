import "server-only";

import { DeterministicCopilotModel } from "@jormall/ai/copilot";
import { StaffCopilotService } from "@jormall/domain/copilot";

import { copilotRepository } from "./identity";

export const staffCopilotService = new StaffCopilotService(
  copilotRepository,
  new DeterministicCopilotModel(),
  copilotRepository,
);
