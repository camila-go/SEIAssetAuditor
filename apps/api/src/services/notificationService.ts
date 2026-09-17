import nodemailer, { type Transporter } from 'nodemailer'
import type { VideoSubmission } from '@prisma/client'
import type { ApproverType } from '@capella/types'
import { config } from '../config.js'
import { logger } from '../lib/logger.js'

/**
 * Email notifications for the intake approval chain.
 *
 * Every function here is best-effort: a notification failure is logged but
 * never propagated. Losing an email must not roll back an approval that has
 * already moved an asset in AEM.
 */

let transporter: Transporter | null = null

function getTransporter(): Transporter | null {
  if (!config.emailEnabled || !config.smtpHost) return null
  if (transporter) return transporter

  transporter = nodemailer.createTransport({
    host: config.smtpHost,
    port: config.smtpPort,
    secure: config.smtpPort === 465,
    auth:
      config.smtpUser && config.smtpPassword
        ? { user: config.smtpUser, pass: config.smtpPassword }
        : undefined,
  })

  return transporter
}

async function send(to: string | undefined, subject: string, body: string): Promise<void> {
  if (!to) {
    logger.warn({ subject }, 'No recipient configured — notification skipped')
    return
  }

  const mailer = getTransporter()
  if (!mailer) {
    // In dev there is usually no SMTP host. Log it so the flow is still traceable.
    logger.info({ to, subject }, 'SMTP not configured — notification logged only')
    return
  }

  try {
    await mailer.sendMail({ from: config.emailFrom, to, subject, text: body })
    logger.info({ to, subject }, 'Notification sent')
  } catch (error) {
    logger.error({ err: error, to, subject }, 'Notification failed to send')
  }
}

export function approverEmailFor(type: ApproverType): string | undefined {
  return type === 'legal' ? config.legalApproverEmail : config.marketingApproverEmail
}

const adminUrl = (submissionId: string): string =>
  `${config.uiOrigin}/admin/intake/${submissionId}`

export async function notifyApprover(
  approverType: ApproverType,
  submission: VideoSubmission,
): Promise<void> {
  await send(
    approverEmailFor(approverType),
    `[SEI Site Auditor] Video awaiting ${approverType} review: ${submission.title}`,
    [
      `A video has been submitted and is waiting for ${approverType} review.`,
      '',
      `Title:      ${submission.title}`,
      `Program:    ${submission.program}`,
      `Campaign:   ${submission.campaign}`,
      `Submitter:  ${submission.submitterName} (${submission.submitterOrg})`,
      `Submitted:  ${submission.submittedAt.toISOString()}`,
      '',
      `Review it here: ${adminUrl(submission.id)}`,
    ].join('\n'),
  )
}

/** Sequential mode: the next approver is only told once the previous one signs off. */
export async function notifyNextApprover(
  nextType: ApproverType,
  submission: VideoSubmission,
): Promise<void> {
  await send(
    approverEmailFor(nextType),
    `[SEI Site Auditor] Ready for ${nextType} review: ${submission.title}`,
    [
      `"${submission.title}" has cleared the previous approval step and is now ready for ${nextType} review.`,
      '',
      `Review it here: ${adminUrl(submission.id)}`,
    ].join('\n'),
  )
}

export async function notifySubmitterApproved(submission: VideoSubmission): Promise<void> {
  await send(
    submission.submitterEmail,
    `[Capella] Your video submission was approved: ${submission.title}`,
    [
      `Hi ${submission.submitterName},`,
      '',
      `Your video "${submission.title}" has been approved by both legal and marketing, and is now in Capella's digital asset library.`,
      '',
      'A content author will place it on the relevant pages — approval does not publish it to the site by itself.',
      '',
      `Reference: ${submission.id}`,
      '',
      'Thank you,',
      'Capella Marketing',
      // Deliberately no AEM paths — submitters never see internal locations.
    ].join('\n'),
  )
}

export async function notifySubmitterRejected(
  submission: VideoSubmission,
  reason: string,
): Promise<void> {
  await send(
    submission.submitterEmail,
    `[Capella] Your video submission needs changes: ${submission.title}`,
    [
      `Hi ${submission.submitterName},`,
      '',
      `Your video "${submission.title}" was not approved.`,
      '',
      'Reason given by the reviewer:',
      reason,
      '',
      `You can submit a revised version here: ${config.uiOrigin}/intake/resubmit/${submission.id}`,
      '',
      `Reference: ${submission.id}`,
      '',
      'Thank you,',
      'Capella Marketing',
    ].join('\n'),
  )
}

export async function notifySubmitterReceived(submission: VideoSubmission): Promise<void> {
  await send(
    submission.submitterEmail,
    `[Capella] We received your video submission: ${submission.title}`,
    [
      `Hi ${submission.submitterName},`,
      '',
      `We've received "${submission.title}" and it's now queued for legal and marketing review.`,
      `You'll hear from us at this address once a decision is made.`,
      '',
      `Your tracking reference: ${submission.id}`,
    ].join('\n'),
  )
}
