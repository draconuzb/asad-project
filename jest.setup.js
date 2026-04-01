/**
 * Jest Setup File
 * Configure test environment and global test utilities
 */

// Increase timeout for Telegram API calls
jest.setTimeout(15000);

// Mock console methods if needed
global.testUtils = {
    mockEnv: (env) => {
        const originalEnv = { ...process.env };
        Object.assign(process.env, env);
        return () => {
            process.env = originalEnv;
        };
    },
};

// Suppress console output during tests (optional)
// global.console = {
//     ...console,
//     log: jest.fn(),
//     debug: jest.fn(),
//     info: jest.fn(),
//     warn: jest.fn(),
//     error: jest.fn(),
// };
