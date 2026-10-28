import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/node_modules/**', '**/dist/**', 'services/**', 'apps/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
  {
    // Invariant 1: all randomness goes through the seeded RNG; invariant 2: no clock.
    files: ['packages/engine/src/**/*.ts'],
    rules: {
      'no-restricted-properties': [
        'error',
        { object: 'Math', property: 'random', message: 'Use the seeded Rng (CLAUDE.md invariant 1).' },
        { object: 'Date', property: 'now', message: 'Time arrives as an input (CLAUDE.md invariant 2).' },
      ],
      'no-restricted-globals': ['error', 'performance', 'setTimeout', 'setInterval', 'fetch'],
      'no-restricted-syntax': [
        'error',
        {
          selector: "NewExpression[callee.name='Date']",
          message: 'Time arrives as an input (CLAUDE.md invariant 2).',
        },
      ],
    },
  },
);
