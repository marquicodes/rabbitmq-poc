module.exports = {
  root: true,
  env: {
    es2022: true,
    node: true
  },
  extends: ['standard', 'plugin:jsdoc/recommended'],
  globals: {
    Atomics: 'readonly',
    SharedArrayBuffer: 'readonly'
  },
  parserOptions: {
    ecmaVersion: 2022,
    ecmaFeatures: { modules: true },
    sourceType: 'module'
  },
  rules: {
    'max-len': ['error', { code: 80, ignoreComments: false, ignoreUrls: true }],
    // Node.js and CommonJS
    'callback-return': ['warn', ['callback', 'next']],
    'global-require': 'error',
    'handle-callback-err': 'warn',
    'no-mixed-requires': 'warn',
    'no-new-require': 'error'
  }
}
