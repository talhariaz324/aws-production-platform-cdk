module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/cdk/test'],
  testMatch: ['**/*.test.ts'],
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: 'tsconfig.json' }],
  },
};
