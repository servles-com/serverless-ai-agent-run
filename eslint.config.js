// L1 lint (C1): dead code and `any` leaks. Type-aware rules are left out on
// purpose — `npm run typecheck` already runs tsc in strict mode.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

// Files that already parse untyped JSON through `any`. New files get the strict
// rule; shrink this list when a file is cleaned up, never grow it.
const anyBaseline = [
  'scripts/dogfood-file-issues.ts',
  'scripts/dogfood-free-models.ts',
  'src/adapters/opencode.ts',
  'src/rooms.ts',
  'src/runner.ts',
  'src/server.ts',
  'src/webhooks.ts',
  'tests/e2e/redaction.test.ts',
  'tests/lib/client.ts',
];

export default tseslint.config(
  { ignores: ['node_modules/'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }],
    },
  },
  { files: anyBaseline, rules: { '@typescript-eslint/no-explicit-any': 'off' } },
  // Plain JS that runs inside the room under node (src/adapters/opencode-live.mjs).
  { files: ['**/*.mjs'], languageOptions: { globals: Object.fromEntries(
    ['process', 'console', 'Buffer', 'fetch', 'AbortController', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval']
      .map(g => [g, 'readonly'])) } },
);
