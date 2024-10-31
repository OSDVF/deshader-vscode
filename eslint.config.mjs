import typescriptEslint from '@typescript-eslint/eslint-plugin';
import tsParser from '@typescript-eslint/parser';

export default [{
    ignores: [
        '**/*.d.ts',
        'node_modules',
        'dist',
    ],
}, {
    plugins: {
        '@typescript-eslint': typescriptEslint,
    },

    languageOptions: {
        parser: tsParser,
        ecmaVersion: 6,
        sourceType: 'module',
    },

    rules: {
        'comma-dangle': ['error', 'always-multiline'],
        curly: ['error', 'all'],
        eqeqeq: 'warn',
        quotes: ['error', 'single'],
        'quote-props': ['warn', 'as-needed'],
        'no-throw-literal': 'warn',
        'no-multiple-empty-lines': ['off'],
        semi: 'off',
        'space-before-function-paren': ['off'],
    },
}];