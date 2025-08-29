module.exports = {
  env: {
    node: true,
    es2022: true,
    jest: true
  },
  extends: [
    'eslint:recommended'
  ],
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: 'module'
  },
  rules: {
    // Code quality
    'no-unused-vars': ['error', { 
      argsIgnorePattern: '^_',
      varsIgnorePattern: '^_' 
    }],
    'no-console': 'off', // Allow console in Node.js
    'no-debugger': 'error',
    'no-alert': 'error',
    
    // Style consistency
    'indent': ['error', 2, { SwitchCase: 1 }],
    'quotes': ['error', 'single', { avoidEscape: true }],
    'semi': ['error', 'always'],
    'comma-dangle': ['error', 'never'],
    'object-curly-spacing': ['error', 'always'],
    'array-bracket-spacing': ['error', 'never'],
    'space-before-blocks': 'error',
    'keyword-spacing': 'error',
    'space-infix-ops': 'error',
    'eol-last': 'error',
    'no-trailing-spaces': 'error',
    
    // Best practices
    'eqeqeq': ['error', 'always'],
    'curly': ['error', 'all'],
    'no-eval': 'error',
    'no-implied-eval': 'error',
    'no-new-func': 'error',
    'no-return-assign': 'error',
    'no-self-compare': 'error',
    'no-throw-literal': 'error',
    'no-unused-expressions': 'error',
    'no-useless-concat': 'error',
    'prefer-const': 'error',
    'no-var': 'error',
    
    // Node.js specific
    'no-process-exit': 'off', // Allow process.exit in CLI tools
    'handle-callback-err': 'error',
    'no-new-require': 'error',
    'no-path-concat': 'error',
    
    // Async/await
    'require-await': 'error',
    'no-return-await': 'error',
    
    // Error handling
    'no-throw-literal': 'error'
  },
  globals: {
    // Node.js globals
    'global': 'readonly',
    'process': 'readonly',
    'Buffer': 'readonly',
    '__dirname': 'readonly',
    '__filename': 'readonly',
    'require': 'readonly',
    'module': 'readonly',
    'exports': 'readonly',
    'console': 'readonly',
    
    // Modern globals
    'fetch': 'readonly'
  },
  overrides: [
    {
      // More relaxed rules for test files
      files: ['**/*.test.js', '**/*.spec.js', '**/tests/**/*.js'],
      rules: {
        'no-unused-expressions': 'off'
      }
    },
    {
      // More relaxed rules for scripts
      files: ['scripts/**/*.js'],
      rules: {
        'no-process-exit': 'off'
      }
    }
  ]
};