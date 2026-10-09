// ESLint flat config (TICKET-001). Lints the whole monorepo from the repository root.
// Formatting is owned by Prettier; eslint-config-prettier disables conflicting ESLint
// stylistic rules. No behavioral rules are disabled.
import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/build/**',
      '**/coverage/**',
      '**/.turbo/**',
      'infra/mojaloop/.artifacts/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
);
