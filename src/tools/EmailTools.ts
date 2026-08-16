/**
 * AiWindowsAssistant
 * Developer: Jose Rodriguez Arroyo <jrpcone@gmail.com>
 * GitHub: https://github.com/jorodriguezpr/aiwindowsassistant
 */

import type { ToolDefinition } from '../providers/AIProvider';
import type { ToolResult } from './AITools';
import { sendEmail } from '../services/EmailService';

export const EMAIL_TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: 'send_email',
    description: 'Send an email (send-only — this app cannot read a mailbox). Requires user approval before sending.',
    parameters: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'Recipient email address' },
        subject: { type: 'string' },
        body: { type: 'string' },
      },
      required: ['to', 'subject', 'body'],
    },
  },
];

export async function executeEmailTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
  if (name !== 'send_email') return { success: false, error: `Unknown email tool: ${name}` };
  const to = String(args.to || '');
  const subject = String(args.subject || '');
  const body = String(args.body || '');
  if (!to || !subject) return { success: false, error: 'to and subject are required' };
  const result = await sendEmail(to, subject, body);
  return result.success
    ? { success: true, output: `Email sent to ${to} (messageId: ${result.messageId})` }
    : { success: false, error: result.error };
}
