import {
  AuditArtifact,
  PlanFailureAction,
  PlanTask,
  PlanTaskStatus
} from './planSchemas';
import type { OutputValidationResult } from './outputContractManager';

export interface ConfidenceGateResult {
  passed: boolean;
  status: PlanTaskStatus;
  reason?: string;
  failedCriteria: string[];
  missingEvidence: string[];
  risks: string[];
}

export class ConfidenceGate {
  evaluate(task: PlanTask, audit: AuditArtifact, outputValidation: OutputValidationResult): ConfidenceGateResult {
    const failedCriteria = task.confidencePolicy.requireAllCriteria
      ? audit.criteriaResults.filter(result => !result.passed).map(result => result.criterion)
      : [];
    const missingEvidence = task.confidencePolicy.requireAllEvidence ? audit.missingEvidence : [];
    const outputErrors = outputValidation.errors.map(error => error.message);
    const canAdvance = outputValidation.valid
      && failedCriteria.length === 0
      && missingEvidence.length === 0
      && audit.nextAction === 'advance';

    if (canAdvance) {
      return {
        passed: true,
        status: 'succeeded',
        failedCriteria: [],
        missingEvidence: [],
        risks: audit.risks
      };
    }

    const reason = this.reasonForFailure(audit, failedCriteria, missingEvidence, outputErrors);
    return {
      passed: false,
      status: this.statusForFailure(task.confidencePolicy.onFailure, audit.nextAction),
      reason,
      failedCriteria,
      missingEvidence,
      risks: audit.risks
    };
  }

  private statusForFailure(onFailure: PlanFailureAction, nextAction: AuditArtifact['nextAction']): PlanTaskStatus {
    if (nextAction === 'needsApproval' || onFailure === 'needsApproval') {
      return 'needsApproval';
    }
    if (onFailure === 'retry') {
      return 'failed';
    }
    return 'blocked';
  }

  private reasonForFailure(
    audit: AuditArtifact,
    failedCriteria: string[],
    missingEvidence: string[],
    outputErrors: string[]
  ): string {
    if (outputErrors.length > 0) {
      return `Output validation failed: ${outputErrors.join('; ')}`;
    }
    if (failedCriteria.length > 0) {
      return `Audit criteria failed: ${failedCriteria.join('; ')}`;
    }
    if (missingEvidence.length > 0) {
      return `Required evidence missing: ${missingEvidence.join('; ')}`;
    }
    return `Audit requested ${audit.nextAction}`;
  }
}
