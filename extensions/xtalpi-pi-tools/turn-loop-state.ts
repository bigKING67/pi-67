import {
  EMPTY_USAGE,
  type UsageSummary,
} from "./protocol.ts";
import {
  canRecoverEmptyResponse as canRecoverEmptyResponseWithCounters,
  canRecoverRepair as canRecoverRepairWithCounters,
} from "./recovery-decision.ts";
import { addUsage } from "./response-normalizer.ts";

export type TurnRecoveryBudget = {
  maxEmptyRetries: number;
  maxRepairRetries: number;
  maxTotalRecoveries: number;
};

export type TurnLoopStateSnapshot = {
  emptyRetries: number;
  repairRetries: number;
  totalRecoveries: number;
  accumulatedUsage: UsageSummary;
  responseModel?: string;
};

export class TurnLoopState {
  #emptyRetries = 0;
  #repairRetries = 0;
  #totalRecoveries = 0;
  #accumulatedUsage = { ...EMPTY_USAGE };
  #responseModel: string | undefined;

  addResponse(response: { usage: UsageSummary; responseModel?: string }): void {
    this.#accumulatedUsage = addUsage(this.#accumulatedUsage, response.usage);
    this.#responseModel = response.responseModel || this.#responseModel;
  }

  canRecoverEmptyResponse(
    budget: Pick<TurnRecoveryBudget, "maxEmptyRetries" | "maxTotalRecoveries">,
  ): boolean {
    return canRecoverEmptyResponseWithCounters(
      { emptyRetries: this.#emptyRetries, totalRecoveries: this.#totalRecoveries },
      budget,
    );
  }

  canRecoverRepair(
    budget: Pick<TurnRecoveryBudget, "maxRepairRetries" | "maxTotalRecoveries">,
  ): boolean {
    return canRecoverRepairWithCounters(
      { repairRetries: this.#repairRetries, totalRecoveries: this.#totalRecoveries },
      budget,
    );
  }

  noteEmptyRecovery(): { emptyRetries: number; totalRecoveries: number } {
    this.#emptyRetries += 1;
    this.#totalRecoveries += 1;
    return {
      emptyRetries: this.#emptyRetries,
      totalRecoveries: this.#totalRecoveries,
    };
  }

  noteRepairRecovery(): { repairRetries: number; totalRecoveries: number } {
    this.#repairRetries += 1;
    this.#totalRecoveries += 1;
    return {
      repairRetries: this.#repairRetries,
      totalRecoveries: this.#totalRecoveries,
    };
  }

  snapshot(): TurnLoopStateSnapshot {
    return {
      emptyRetries: this.#emptyRetries,
      repairRetries: this.#repairRetries,
      totalRecoveries: this.#totalRecoveries,
      accumulatedUsage: { ...this.#accumulatedUsage },
      ...(this.#responseModel ? { responseModel: this.#responseModel } : {}),
    };
  }

  resultFields(): { usage: UsageSummary; responseModel?: string } {
    return {
      usage: { ...this.#accumulatedUsage },
      ...(this.#responseModel ? { responseModel: this.#responseModel } : {}),
    };
  }
}
