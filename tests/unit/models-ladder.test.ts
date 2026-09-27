// Guards the owner's decision (configured several times, lost several times):
// agents use the LLM ladder (OpenCode Go first), not OpenRouter directly.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { opencodeAdapter } from '../../src/adapters/opencode.ts';
import { config } from '../../src/config.ts';

test('default model is the ladder, not a direct OpenRouter model', () => {
  if (process.env.SAR_DEFAULT_MODEL) return;   // explicit override in the environment
  assert.equal(config.defaults.model, 'ladder/free');
});

test('opencode rooms get the ladder provider with the token referenced, never inlined', () => {
  const env = opencodeAdapter.env({ agent: 'opencode', task: 't' }, 'ladder/free');
  const cfg = JSON.parse(env.OPENCODE_CONFIG_CONTENT);
  assert.equal(cfg.provider.ladder.options.apiKey, '{env:LLM_LADDER_TOKEN}');
  assert.match(cfg.provider.ladder.options.baseURL, /^https:\/\//);
  assert.ok(cfg.provider.ladder.models.free.tool_call, 'tools must be enabled for the ladder model');
});

test('the ladder token is provider env, so it reaches rooms and is redacted from logs', () => {
  assert.ok(config.providerEnv.includes('LLM_LADDER_TOKEN'));
});
