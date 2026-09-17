import type { VideoApproval } from '@prisma/client'
import type { ApproverType, SubmissionStatus } from '@capella/types'

/**
 * Approval chain rules, kept pure so both modes are unit-testable without a DB.
 *
 * Mode comes from `APPROVAL_CHAIN_MODE`. PRD §11 lists the choice between
 * sequential and parallel as an open question owned by Legal + Marketing, so
 * both are implemented and switchable by config rather than one being assumed.
 *
 *   sequential — legal reviews first; marketing is only notified afterwards
 *   parallel   — both are notified at submission; both must approve
 */

export type ChainMode = 'sequential' | 'parallel'

export const SEQUENTIAL_ORDER: readonly ApproverType[] = ['legal', 'marketing']

export interface ChainState {
  legal: VideoApproval | null
  marketing: VideoApproval | null
}

export function toChainState(approvals: VideoApproval[]): ChainState {
  return {
    legal: approvals.find((approval) => approval.approverType === 'legal') ?? null,
    marketing: approvals.find((approval) => approval.approverType === 'marketing') ?? null,
  }
}

/** Approver types that may act right now. Empty once the chain is resolved. */
export function awaitingApprovers(mode: ChainMode, state: ChainState): ApproverType[] {
  // Any rejection ends the chain immediately — nobody else needs to weigh in.
  if (state.legal?.decision === 'rejected' || state.marketing?.decision === 'rejected') {
    return []
  }

  if (mode === 'parallel') {
    return SEQUENTIAL_ORDER.filter((type) => state[type] === null)
  }

  // Sequential: the first approver in order who hasn't decided yet.
  for (const type of SEQUENTIAL_ORDER) {
    if (state[type] === null) return [type]
  }
  return []
}

/** Whether this approver is allowed to act at this point in the chain. */
export function canAct(mode: ChainMode, state: ChainState, approverType: ApproverType): boolean {
  return awaitingApprovers(mode, state).includes(approverType)
}

/** The approver to notify after `justDecided` approves. Null in parallel mode. */
export function nextApproverAfter(
  mode: ChainMode,
  state: ChainState,
  justDecided: ApproverType,
): ApproverType | null {
  if (mode === 'parallel') return null

  const index = SEQUENTIAL_ORDER.indexOf(justDecided)
  for (let i = index + 1; i < SEQUENTIAL_ORDER.length; i++) {
    const candidate = SEQUENTIAL_ORDER[i]
    if (candidate && state[candidate] === null) return candidate
  }
  return null
}

/**
 * Submission status implied by the approvals recorded so far.
 *
 * `legal_approved` / `marketing_approved` are partial states: exactly one side
 * has signed off. `approved` requires both, in either mode.
 */
export function deriveStatus(state: ChainState): SubmissionStatus {
  if (state.legal?.decision === 'rejected' || state.marketing?.decision === 'rejected') {
    return 'rejected'
  }

  const legalApproved = state.legal?.decision === 'approved'
  const marketingApproved = state.marketing?.decision === 'approved'

  if (legalApproved && marketingApproved) return 'approved'
  if (legalApproved) return 'legal_approved'
  if (marketingApproved) return 'marketing_approved'
  return 'pending_review'
}

/** True when the asset should now be moved into the live DAM. */
export function isFullyApproved(state: ChainState): boolean {
  return deriveStatus(state) === 'approved'
}

/** Approvers to notify at submission time. */
export function initialNotifyList(mode: ChainMode): ApproverType[] {
  return mode === 'parallel' ? [...SEQUENTIAL_ORDER] : [SEQUENTIAL_ORDER[0]!]
}
