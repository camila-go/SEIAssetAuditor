import type { VideoApproval } from '@prisma/client'
import {
  awaitingApprovers,
  canAct,
  deriveStatus,
  initialNotifyList,
  isFullyApproved,
  nextApproverAfter,
  toChainState,
  type ChainState,
} from './approvalChain.js'

function approval(
  approverType: 'legal' | 'marketing',
  decision: 'approved' | 'rejected',
): VideoApproval {
  return {
    id: `${approverType}-${decision}`,
    submissionId: 'submission-1',
    approverType,
    approverEmail: `${approverType}@capella.edu`,
    decision,
    reason: decision === 'rejected' ? 'Rights unclear' : null,
    decidedAt: new Date(),
  }
}

const EMPTY: ChainState = { legal: null, marketing: null }

describe('toChainState', () => {
  it('maps approvals onto their approver slots', () => {
    const state = toChainState([approval('legal', 'approved')])
    expect(state.legal?.decision).toBe('approved')
    expect(state.marketing).toBeNull()
  })
})

describe('sequential mode', () => {
  it('starts with legal only', () => {
    expect(awaitingApprovers('sequential', EMPTY)).toEqual(['legal'])
  })

  it('does not let marketing act before legal', () => {
    expect(canAct('sequential', EMPTY, 'marketing')).toBe(false)
    expect(canAct('sequential', EMPTY, 'legal')).toBe(true)
  })

  it('moves to marketing once legal approves', () => {
    const state = toChainState([approval('legal', 'approved')])
    expect(awaitingApprovers('sequential', state)).toEqual(['marketing'])
    expect(nextApproverAfter('sequential', state, 'legal')).toBe('marketing')
  })

  it('notifies only the first approver at submission', () => {
    expect(initialNotifyList('sequential')).toEqual(['legal'])
  })
})

describe('parallel mode', () => {
  it('lets either approver act first', () => {
    expect(awaitingApprovers('parallel', EMPTY).sort()).toEqual(['legal', 'marketing'])
    expect(canAct('parallel', EMPTY, 'marketing')).toBe(true)
  })

  it('still waits for the other approver after one approves', () => {
    const state = toChainState([approval('marketing', 'approved')])
    expect(awaitingApprovers('parallel', state)).toEqual(['legal'])
  })

  it('has no "next" approver to notify — both were told at submission', () => {
    const state = toChainState([approval('legal', 'approved')])
    expect(nextApproverAfter('parallel', state, 'legal')).toBeNull()
  })

  it('notifies both approvers at submission', () => {
    expect(initialNotifyList('parallel').sort()).toEqual(['legal', 'marketing'])
  })
})

describe('rejection', () => {
  it('ends the chain immediately in either mode', () => {
    const state = toChainState([approval('legal', 'rejected')])
    expect(awaitingApprovers('sequential', state)).toEqual([])
    expect(awaitingApprovers('parallel', state)).toEqual([])
  })

  it('makes the submission status rejected', () => {
    expect(deriveStatus(toChainState([approval('marketing', 'rejected')]))).toBe('rejected')
  })

  it('outranks an existing approval from the other side', () => {
    const state = toChainState([approval('legal', 'approved'), approval('marketing', 'rejected')])
    expect(deriveStatus(state)).toBe('rejected')
    expect(isFullyApproved(state)).toBe(false)
  })
})

describe('deriveStatus', () => {
  it('is pending_review with no decisions', () => {
    expect(deriveStatus(EMPTY)).toBe('pending_review')
  })

  it('is legal_approved when only legal has signed off', () => {
    expect(deriveStatus(toChainState([approval('legal', 'approved')]))).toBe('legal_approved')
  })

  it('is marketing_approved when only marketing has signed off', () => {
    expect(deriveStatus(toChainState([approval('marketing', 'approved')]))).toBe(
      'marketing_approved',
    )
  })

  it('requires both approvals to reach approved', () => {
    const state = toChainState([approval('legal', 'approved'), approval('marketing', 'approved')])
    expect(deriveStatus(state)).toBe('approved')
    expect(isFullyApproved(state)).toBe(true)
  })
})

describe('acting twice', () => {
  it('does not list an approver who has already decided', () => {
    const state = toChainState([approval('legal', 'approved')])
    expect(canAct('sequential', state, 'legal')).toBe(false)
    expect(canAct('parallel', state, 'legal')).toBe(false)
  })

  it('leaves nobody awaiting once both have decided', () => {
    const state = toChainState([approval('legal', 'approved'), approval('marketing', 'approved')])
    expect(awaitingApprovers('sequential', state)).toEqual([])
    expect(awaitingApprovers('parallel', state)).toEqual([])
  })
})
