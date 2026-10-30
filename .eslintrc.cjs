module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  plugins: ['@typescript-eslint', 'react', 'react-hooks'],
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
    'plugin:react/recommended',
  ],
  settings: { react: { version: 'detect' } },
  env: { browser: true, es2022: true, node: true, webextensions: true },
  ignorePatterns: ['**/dist/**', '**/node_modules/**', 'coverage/**', '*.js'],
  rules: {
    'react/react-in-jsx-scope': 'off',
    '@typescript-eslint/no-explicit-any': 'off',
    '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
    'no-console': 'off',
    // The rules react-hooks/recommended had before it added the React Compiler rules.
    'react-hooks/rules-of-hooks': 'error',
    'react-hooks/exhaustive-deps': 'warn',
  },
  overrides: [
    {
      // The server discards destructured fields with a leading underscore (`{ secret: _secret, ...rest }`).
      files: ['packages/server/**/*.ts', 'workers/api/**/*.ts', 'workers/server-tracker/**/*.ts'],
      rules: { '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', ignoreRestSiblings: true }] },
    },
  ],
};
