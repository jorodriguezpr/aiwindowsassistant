/**
 * AiWindowsAssistant
 * Developer: Jose Rodriguez Arroyo <jrpcone@gmail.com>
 * GitHub: https://github.com/jorodriguezpr/aiwindowsassistant
 */

import nodemailer, { Transporter } from 'nodemailer';
import { config } from '../config';

let transporter: Transporter | null = null;

function getTransporter(): Transporter | null {
  if (!config.email.host || !config.email.user || !config.email.pass) return null;
  if (transporter) return transporter;
  transporter = nodemailer.createTransport({
    host: config.email.host,
    port: config.email.port,
    secure: config.email.secure,
    auth: { user: config.email.user, pass: config.email.pass },
  });
  return transporter;
}

export function isEmailConfigured(): boolean {
  return getTransporter() !== null;
}

export interface SendEmailResult {
  success: boolean;
  messageId?: string;
  error?: string;
}

/** Send-only by design — no inbox reading. See project README for the tradeoff. */
export async function sendEmail(to: string, subject: string, body: string): Promise<SendEmailResult> {
  const t = getTransporter();
  if (!t) return { success: false, error: 'Email is not configured (EMAIL_SMTP_HOST/USER/PASS missing in .env)' };
  try {
    const info = await t.sendMail({ from: config.email.from || config.email.user, to, subject, text: body });
    return { success: true, messageId: info.messageId };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}
