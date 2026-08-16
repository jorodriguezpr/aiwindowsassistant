/**
 * AiWindowsAssistant
 * Developer: Jose Rodriguez Arroyo <jrpcone@gmail.com>
 * GitHub: https://github.com/jorodriguezpr/aiwindowsassistant
 */

import axios, { AxiosInstance } from 'axios';
import { config, ProviderName } from '../config';
import { logTokenUsage } from '../utils/tokenUsage';
import type { Logger } from '../logger';

export interface ToolCall {
  id: string;
  name: string;
  /** JSON string of arguments (OpenAI convention; normalized for both providers) */
  arguments: string;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  /** Present on assistant messages that requested tools */
  tool_calls?: ToolCall[];
  /** Present on tool-result messages */
  tool_call_id?: string;
  name?: string;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema
}

export interface Usage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface ChatResponse {
  content: string;
  toolCalls: ToolCall[];
  usage?: Usage;
}

/**
 * Port of AiAgentAssistant's utils/AIProvider.ts (Windows edition).
 * Providers: anthropic (native /v1/messages + tool_use), ollama-cloud and
 * ollama (OpenAI-compatible /v1/chat/completions).
 */
export class AIProvider {
  private http: AxiosInstance;
  private provider: ProviderName;
  private model: string;
  private logger?: Logger;

  constructor(logger?: Logger) {
    this.provider = config.ai.provider;
    this.model = config.ai.model || config.defaultModel(this.provider);
    this.logger = logger;
    this.http = axios.create({ timeout: 300000 });
  }

  getProvider(): ProviderName {
    return this.provider;
  }

  getModel(): string {
    return this.model;
  }

  setModel(model: string): void {
    this.model = model;
  }

  /** Runtime provider switch (improvement over AiAgentAssistant, which needed a restart). */
  setProvider(provider: ProviderName, model?: string): void {
    this.provider = provider;
    this.model = model || config.defaultModel(provider);
  }

  getInfo(): string {
    return `${this.provider} / ${this.model}`;
  }

  async chatCompletion(messages: ChatMessage[], tools?: ToolDefinition[]): Promise<ChatResponse> {
    const started = Date.now();
    let response: ChatResponse;
    if (this.provider === 'anthropic') {
      response = await this.anthropicChat(messages, tools);
    } else {
      response = await this.openAiCompatibleChat(messages, tools);
    }
    if (response.usage) {
      // Fire-and-forget — logging failure must not fail the request
      setImmediate(() =>
        logTokenUsage({
          provider: this.provider,
          model: this.model,
          promptTokens: response.usage!.promptTokens,
          completionTokens: response.usage!.completionTokens,
          totalTokens: response.usage!.totalTokens,
          operation: 'chatCompletion',
        })
      );
    }
    this.logger?.debug(
      { provider: this.provider, model: this.model, ms: Date.now() - started, toolCalls: response.toolCalls.length },
      'chatCompletion done'
    );
    return response;
  }

  // ---------- Anthropic ----------

  private async anthropicChat(messages: ChatMessage[], tools?: ToolDefinition[]): Promise<ChatResponse> {
    const systemParts = messages.filter((m) => m.role === 'system').map((m) => m.content);
    const nonSystem = messages.filter((m) => m.role !== 'system');

    const anthropicMessages: unknown[] = [];
    for (const m of nonSystem) {
      if (m.role === 'tool') {
        // Tool results become user messages with tool_result blocks
        anthropicMessages.push({
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: m.tool_call_id,
              content: m.content,
            },
          ],
        });
      } else if (m.role === 'assistant' && m.tool_calls && m.tool_calls.length > 0) {
        const content: unknown[] = [];
        if (m.content) content.push({ type: 'text', text: m.content });
        for (const tc of m.tool_calls) {
          let input: unknown = {};
          try {
            input = JSON.parse(tc.arguments || '{}');
          } catch {
            input = {};
          }
          content.push({ type: 'tool_use', id: tc.id, name: tc.name, input });
        }
        anthropicMessages.push({ role: 'assistant', content });
      } else {
        anthropicMessages.push({ role: m.role, content: m.content });
      }
    }

    const body: Record<string, unknown> = {
      model: this.model,
      max_tokens: config.ai.maxTokens,
      temperature: config.ai.temperature,
      messages: anthropicMessages,
    };
    if (systemParts.length > 0) body.system = systemParts.join('\n\n');
    if (tools && tools.length > 0) {
      body.tools = tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }));
    }

    const resp = await this.http.post('https://api.anthropic.com/v1/messages', body, {
      headers: {
        'x-api-key': config.ai.anthropicApiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
    });

    const blocks: Array<{ type: string; text?: string; id?: string; name?: string; input?: unknown }> =
      resp.data.content || [];
    const content = blocks
      .filter((b) => b.type === 'text')
      .map((b) => b.text || '')
      .join('');
    const toolCalls: ToolCall[] = blocks
      .filter((b) => b.type === 'tool_use')
      .map((b) => ({ id: b.id!, name: b.name!, arguments: JSON.stringify(b.input ?? {}) }));

    const usage: Usage | undefined = resp.data.usage
      ? {
          promptTokens: resp.data.usage.input_tokens || 0,
          completionTokens: resp.data.usage.output_tokens || 0,
          totalTokens: (resp.data.usage.input_tokens || 0) + (resp.data.usage.output_tokens || 0),
        }
      : undefined;

    return { content, toolCalls, usage };
  }

  // ---------- Ollama Cloud / local Ollama (OpenAI-compatible) ----------

  private async openAiCompatibleChat(messages: ChatMessage[], tools?: ToolDefinition[]): Promise<ChatResponse> {
    const isCloud = this.provider === 'ollama-cloud';
    const baseUrl = isCloud ? config.ai.ollamaCloudBaseUrl : config.ai.ollamaBaseUrl;
    const apiKey = isCloud ? config.ai.ollamaCloudApiKey : undefined;

    const apiMessages = messages.map((m) => {
      if (m.role === 'tool') {
        return { role: 'tool', tool_call_id: m.tool_call_id, content: m.content };
      }
      if (m.role === 'assistant' && m.tool_calls && m.tool_calls.length > 0) {
        return {
          role: 'assistant',
          content: m.content || null,
          tool_calls: m.tool_calls.map((tc) => ({
            id: tc.id,
            type: 'function',
            function: { name: tc.name, arguments: tc.arguments },
          })),
        };
      }
      return { role: m.role, content: m.content };
    });

    const body: Record<string, unknown> = {
      model: this.model,
      messages: apiMessages,
      max_tokens: config.ai.maxTokens,
      temperature: config.ai.temperature,
    };
    if (tools && tools.length > 0) {
      body.tools = tools.map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.parameters },
      }));
      body.tool_choice = 'auto';
    }

    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

    const resp = await this.http.post(`${baseUrl}/v1/chat/completions`, body, { headers });

    const msg = resp.data.choices?.[0]?.message || {};
    const toolCalls: ToolCall[] = (msg.tool_calls || []).map(
      (tc: { id?: string; function?: { name?: string; arguments?: unknown } }, i: number) => ({
        id: tc.id || `call_${i}`,
        name: tc.function?.name || '',
        // Ollama may return arguments as object — normalize to JSON string
        arguments:
          typeof tc.function?.arguments === 'string'
            ? tc.function.arguments
            : JSON.stringify(tc.function?.arguments ?? {}),
      })
    );

    const usage: Usage | undefined = resp.data.usage
      ? {
          promptTokens: resp.data.usage.prompt_tokens || 0,
          completionTokens: resp.data.usage.completion_tokens || 0,
          totalTokens: resp.data.usage.total_tokens || 0,
        }
      : undefined;

    return { content: msg.content || '', toolCalls, usage };
  }
}
