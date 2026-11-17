// Lint rules of this package: the flat config shared by @rancher/shell, unchanged.
// (The repository's root .eslintrc.js extends a config that is not installed and is not used here.)
import shellConfig from '@rancher/shell/eslint.config.base.mjs';

export default [
  ...shellConfig,
  { ignores: ['**/node_modules/**', '**/.shell/**'] },
  {
    files: ['**/*.{js,ts,vue}'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      'vue/multi-word-component-names':     'off',
    },
  },
];
