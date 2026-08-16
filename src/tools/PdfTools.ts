/**
 * AiWindowsAssistant
 * Developer: Jose Rodriguez Arroyo <jrpcone@gmail.com>
 * GitHub: https://github.com/jorodriguezpr/aiwindowsassistant
 */

import PDFDocument from 'pdfkit';
import * as fs from 'fs';
import * as path from 'path';
import type { ToolDefinition } from '../providers/AIProvider';
import type { ToolResult } from './AITools';
import { config } from '../config';

export const PDF_TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: 'generate_pdf',
    description: `Generate a PDF document with a title and body text, saved to ${config.assistant.documentsDir}.`,
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        content: { type: 'string', description: 'Body text — plain paragraphs, one per line' },
        filename: { type: 'string', description: 'Optional; defaults to a slug of the title plus a timestamp' },
      },
      required: ['title', 'content'],
    },
  },
];

function slugify(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return slug || 'document';
}

export async function executePdfTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
  if (name !== 'generate_pdf') return { success: false, error: `Unknown document tool: ${name}` };
  const title = String(args.title || '').trim();
  const content = String(args.content || '');
  if (!title) return { success: false, error: 'title is required' };

  const rawName = typeof args.filename === 'string' && args.filename ? args.filename : `${slugify(title)}-${Date.now()}`;
  const safeName = path.basename(rawName).replace(/[^a-zA-Z0-9._-]/g, '_');
  const filename = safeName.toLowerCase().endsWith('.pdf') ? safeName : `${safeName}.pdf`;

  fs.mkdirSync(config.assistant.documentsDir, { recursive: true });
  const outPath = path.join(config.assistant.documentsDir, filename);

  await new Promise<void>((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50 });
    const stream = fs.createWriteStream(outPath);
    doc.pipe(stream);
    doc.fontSize(18).text(title, { underline: true });
    doc.moveDown();
    doc.fontSize(11).text(content, { align: 'left' });
    doc.end();
    stream.on('finish', () => resolve());
    stream.on('error', reject);
  });

  return { success: true, output: `PDF written to ${outPath}` };
}
