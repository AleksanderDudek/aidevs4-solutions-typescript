/**
 * LLM provider abstraction.
 *
 * Usage:
 *   import { getProvider } from "../lib/llm/index.js";
 *   const llm = getProvider();            // default: Anthropic
 *   const llm = getProvider("anthropic"); // explicit
 *   const llm = getProvider("openai");    // once implemented
 *
 * Convenience wrappers (use the default provider):
 *   import { complete, completeStructured, runAgent } from "../lib/llm/index.js";
 */

import { AnthropicProvider } from "./providers/anthropic.js";
import { GeminiProvider } from "./providers/gemini.js";
import { OpenAIProvider } from "./providers/openai.js";
import type {
  AgentTool,
  ChatSession,
  CompleteOptions,
  ContentBlock,
  LLMProvider,
  ToolSchema,
} from "./types.js";

// Re-export all types so callers only need one import path
export type {
  AgentTool,
  ChatSession,
  CompleteOptions,
  ContentBlock,
  ImageContent,
  ImageUrlContent,
  LLMProvider,
  TextContent,
  ToolDefinition,
  ToolHandler,
  ToolSchema,
} from "./types.js";

export { AnthropicProvider } from "./providers/anthropic.js";
export { GeminiProvider } from "./providers/gemini.js";
export { OpenAIProvider } from "./providers/openai.js";

// ─── Provider names ───────────────────────────────────────────────────────────

export type ProviderName = "anthropic" | "gemini" | "openai";

// ─── Singleton registry ───────────────────────────────────────────────────────

const _instances = new Map<ProviderName, LLMProvider>();

/**
 * Returns (and lazily instantiates) a provider by name.
 * Defaults to "anthropic" if no name is given.
 */
export function getProvider(name: ProviderName = "anthropic"): LLMProvider {
  if (!_instances.has(name)) {
    switch (name) {
      case "anthropic":
        _instances.set(name, new AnthropicProvider());
        break;
      case "gemini":
        _instances.set(name, new GeminiProvider());
        break;
      case "openai":
        _instances.set(name, new OpenAIProvider());
        break;
      default: {
        const _exhaustive: never = name;
        throw new Error(`Unknown LLM provider: ${_exhaustive}`);
      }
    }
  }
  return _instances.get(name)!;
}

// ─── Convenience wrappers (default = Anthropic) ───────────────────────────────

/**
 * Single-turn text or multimodal completion via the default provider.
 */
export function complete(
  systemPrompt: string,
  userMessage: string | ContentBlock[],
  model = "claude-sonnet-4-20250514"
): Promise<string> {
  return getProvider().complete(systemPrompt, userMessage, { model });
}

/**
 * Structured output (forced tool_use) via the default provider.
 */
export function completeStructured<T>(
  systemPrompt: string,
  userMessage: string | ContentBlock[],
  toolName: string,
  toolDescription: string,
  inputSchema: ToolSchema,
  model = "claude-sonnet-4-20250514"
): Promise<T> {
  return getProvider().completeStructured<T>(
    systemPrompt,
    userMessage,
    toolName,
    toolDescription,
    inputSchema,
    { model }
  );
}

/**
 * Autonomous agent loop via the default provider.
 */
export function runAgent(
  systemPrompt: string,
  userMessage: string,
  tools: AgentTool[],
  maxIterations = 20,
  model = "claude-sonnet-4-20250514"
): Promise<void> {
  return getProvider().runAgent(systemPrompt, userMessage, tools, maxIterations, {
    model,
  });
}
