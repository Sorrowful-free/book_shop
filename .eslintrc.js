module.exports = {
  parser: '@typescript-eslint/parser',
  parserOptions: {
    sourceType: 'module',
  },
  plugins: ['@typescript-eslint/eslint-plugin'],
  extends: [
    'plugin:@typescript-eslint/recommended',
    'plugin:prettier/recommended',
  ],
  root: true,
  env: {
    node: true,
  },
  ignorePatterns: [
    '.eslintrc.js',
    'node_modules',
    'dist',
    '.nuxt',
    '.output',
    'coverage',
    '**/src/generated/**',
  ],
  rules: {
    '@typescript-eslint/explicit-function-return-type': 'off',
    '@typescript-eslint/explicit-module-boundary-types': 'off',
    '@typescript-eslint/no-explicit-any': 'off',
    '@typescript-eslint/no-unused-vars': [
      'error',
      { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
    ],
    'no-restricted-globals': [
      'error',
      {
        name: 'Bun',
        message:
          'Bun-only APIs are forbidden — code must run under Node.js too (see AGENTS.md)',
      },
    ],
    'no-restricted-imports': [
      'error',
      {
        patterns: [
          {
            group: ['bun', 'bun:*'],
            message:
              'Bun-only modules are forbidden in app code (see AGENTS.md)',
          },
        ],
      },
    ],
  },
  overrides: [
    {
      // test files may use the bun test runner (dev tooling only)
      files: ['**/*.spec.ts', '**/test/**/*.ts'],
      rules: {
        'no-restricted-syntax': [
          'error',
          {
            selector:
              "CallExpression[callee.object.name='mock'][callee.property.name='module']",
            message:
              'mock.module leaks across test files — use DI or local fakes (see AGENTS.md)',
          },
        ],
        'no-restricted-imports': [
          'error',
          {
            patterns: [
              {
                group: ['bun', 'bun:*', '!bun:test'],
                message:
                  'Only "bun:test" is allowed in test files (see AGENTS.md)',
              },
            ],
          },
        ],
      },
    },
  ],
};
