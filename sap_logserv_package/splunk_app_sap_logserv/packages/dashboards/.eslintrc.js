module.exports = {
    parser: '@typescript-eslint/parser',
    plugins: ['@typescript-eslint'],
    extends: ['@splunk/eslint-config/base', '@splunk/eslint-config/browser-prettier'],
    rules: {
        'react/jsx-filename-extension': ['error', { extensions: ['.tsx', '.jsx'] }],
        // without this rule, unit test files will fail for importing devDependency packages
        'import/no-extraneous-dependencies': [
            'error',
            {
                devDependencies: ['src/**/tests/*.unit*'],
            },
        ],
    },
    overrides: [
        {
            files: ['src/**/tests/*.unit*'],
            env: {
                jest: true,
            },
        },
    ],
};
