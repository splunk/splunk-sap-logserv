module.exports = {
    testMatch: ['**/*.unit.[jt]s?(x)'],
    testEnvironment: 'jsdom',
    setupFilesAfterEnv: ['<rootDir>/unit-test-setup-testing-library.ts'],
};
