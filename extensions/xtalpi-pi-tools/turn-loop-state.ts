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
  maxFormatRecoveries?: number;
  maxFinalRecoveries?: number;
  maxRepeatedCallRecoveries?: number;
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
  #formatRecoveries = 0;
  #finalRecoveries = 0;
  #repeatedCallRecoveries = 0;
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

  canRecoverFormat(
    budget: Pick<TurnRecoveryBudget, "maxRepairRetries" | "maxTotalRecoveries" | "maxFormatRecoveries">,
  ): boolean {
    return this.canRecoverRepair(budget) &&
      this.#formatRecoveries < (budget.maxFormatRecoveries ?? budget.maxRepairRetries);
  }

  canRecoverFinal(
    budget: Pick<TurnRecoveryBudget, "maxRepairRetries" | "maxTotalRecoveries" | "maxFinalRecoveries">,
  ): boolean {
    return this.canRecoverRepair(budget) &&
      this.#finalRecoveries < (budget.maxFinalRecoveries ?? budget.maxRepairRetries);
  }

  canRecoverRepeatedCall(
    budget: Pick<TurnRecoveryBudget, "maxRepairRetries" | "maxTotalRecoveries" | "maxRepeatedCallRecoveries">,
  ): boolean {
    return this.canRecoverRepair(budget) &&
      this.#repeatedCallRecoveries < (budget.maxRepeatedCallRecoveries ?? budget.maxRepairRetries);
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

  noteFormatRecovery(): {
    formatRecoveries: number;
    repairRetries: number;
    totalRecoveries: number;
  } {
    this.#formatRecoveries += 1;
    return { formatRecoveries: this.#formatRecoveries, ...this.noteRepairRecovery() };
  }

  noteFinalRecovery(): {
    finalRecoveries: number;
    repairRetries: number;
    totalRecoveries: number;
  } {
    this.#finalRecoveries += 1;
    return { finalRecoveries: this.#finalRecoveries, ...this.noteRepairRecovery() };
  }

  noteRepeatedCallRecovery(): {
    repeatedCallRecoveries: number;
    repairRetries: number;
    totalRecoveries: number;
  } {
    this.#repeatedCallRecoveries += 1;
    return { repeatedCallRecoveries: this.#repeatedCallRecoveries, ...this.noteRepairRecovery() };
  }

  recoveryDetails(): {
    formatRecoveries: number;
    finalRecoveries: number;
    repeatedCallRecoveries: number;
  } {
    return {
      formatRecoveries: this.#formatRecoveries,
      finalRecoveries: this.#finalRecoveries,
      repeatedCallRecoveries: this.#repeatedCallRecoveries,
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
