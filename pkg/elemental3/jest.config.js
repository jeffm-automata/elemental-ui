// Unit tests of the plain TypeScript in lib/ (no Rancher shell needed).
module.exports = {
  rootDir:         __dirname,
  testEnvironment: 'node',
  testMatch:       ['<rootDir>/lib/__tests__/**/*.test.ts'],
  transform:       {
    '^.+\\.ts$': ['babel-jest', {
      babelrc:    false,
      configFile: false,
      presets:    [['@babel/preset-env', { targets: { node: 'current' } }], '@babel/preset-typescript'],
    }],
  },
};
