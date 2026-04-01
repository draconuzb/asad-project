/**
 * Jest Configuration
 * Configure test runner, coverage, and test environment
 */

module.exports = {
    // Test environment
    testEnvironment: 'node',
    
    // Collect coverage from these patterns
    collectCoverageFrom: [
        '*.js',
        '!jest.config.js',
        '!bot.js',  // Entry point, tested via integration
        '!node_modules/**',
        '!tests/**',
        '!*.test.js',
    ],
    
    // Coverage thresholds
    coverageThreshold: {
        global: {
            branches: 60,
            functions: 60,
            lines: 60,
            statements: 60,
        },
    },
    
    // Test match patterns
    testMatch: [
        '**/__tests__/**/*.js',
        '**/?(*.)+(spec|test).js',
    ],
    
    // Setup files
    setupFilesAfterEnv: ['<rootDir>/jest.setup.js'],
    
    // Timeout for tests
    testTimeout: 10000,
    
    // Verbose output
    verbose: true,
    
    // Clear mocks between tests
    clearMocks: true,
    
    // Force exit after tests
    forceExit: true,
    
    // Bail on first test failure (optional, remove for full run)
    bail: false,
};
