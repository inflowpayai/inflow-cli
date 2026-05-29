import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';
import jsdoc from 'eslint-plugin-jsdoc';

export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/node_modules/**', '**/coverage/**', '**/.turbo/**', '**/*.cjs'],
  },
  ...tseslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked.map((config) => ({
    ...config,
    files: ['packages/**/src/**/*.{ts,tsx}', 'packages/**/test/**/*.{ts,tsx}'],
    languageOptions: {
      ...config.languageOptions,
      parserOptions: {
        ...config.languageOptions?.parserOptions,
        project: ['./packages/*/tsconfig.test.json'],
        tsconfigRootDir: import.meta.dirname,
      },
    },
  })),
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          destructuredArrayIgnorePattern: '^_',
        },
      ],
    },
  },
  {
    files: ['packages/**/src/**/*.{ts,tsx}'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',
      '@typescript-eslint/prefer-readonly': 'warn',
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'separate-type-imports' },
      ],
    },
  },
  {
    files: ['packages/**/test/**/*.{ts,tsx}'],
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'separate-type-imports' },
      ],
    },
  },
  {
    files: ['packages/**/src/**/*.{ts,tsx}'],
    plugins: { jsdoc },
    settings: {
      jsdoc: { mode: 'typescript' },
    },
    rules: {
      'jsdoc/no-types': 'error',
      'jsdoc/no-blank-blocks': 'error',
      'jsdoc/empty-tags': 'error',
      'jsdoc/check-tag-names': ['error', { definedTags: ['internal', 'typeParam'] }],
      'jsdoc/check-alignment': 'error',
      'jsdoc/multiline-blocks': 'error',
      'jsdoc/no-multi-asterisks': 'error',
      'jsdoc/require-asterisk-prefix': 'error',
      'jsdoc/check-param-names': 'warn',
      'jsdoc/no-defaults': 'warn',
      'jsdoc/require-hyphen-before-param-description': ['warn', 'always'],
    },
  },
  {
    files: ['packages/**/src/**/*.{ts,tsx}'],
    rules: {
      'no-console': 'error',
    },
  },
  // Core may not depend on any CLI-rendering library. The split between `@inflowpayai/inflow-core` (headless, importable into any Node
  // project) and `@inflowpayai/inflow` (the CLI binary) only works if these stay out of core; the rule below is the enforcement layer.
  // Add new bans here when promoting other CLI-only deps.
  {
    files: ['packages/core/src/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            { name: 'react', message: 'react is a CLI-only dep; core must stay headless.' },
            { name: 'react-dom', message: 'react-dom is a CLI-only dep; core must stay headless.' },
            { name: 'ink', message: 'ink is a CLI-only dep; core must stay headless.' },
            { name: 'ink-spinner', message: 'ink-spinner is a CLI-only dep; core must stay headless.' },
            { name: 'ink-testing-library', message: 'ink-testing-library is a CLI-only dep; core must stay headless.' },
            { name: 'incur', message: 'incur is a CLI framework dep; core must not consume it.' },
            { name: 'update-notifier', message: 'update-notifier is a CLI-only dep; core must not consume it.' },
          ],
          patterns: [
            { group: ['react/*'], message: 'react is a CLI-only dep; core must stay headless.' },
            { group: ['ink/*'], message: 'ink is a CLI-only dep; core must stay headless.' },
          ],
        },
      ],
    },
  },
  prettier,
);
