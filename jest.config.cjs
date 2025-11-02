module.exports = {
  transform: { "^.+\\.m?js$": "babel-jest" },
  testEnvironment: "node",
  moduleFileExtensions: ["js", "mjs"],
  roots: ["<rootDir>/__tests__"],
  moduleDirectories: ["node_modules", "__mocks__"],
  moduleNameMapper: {
    "^@sparticuz/chromium$": "<rootDir>/__mocks__/@sparticuz/chromium.js",
    "^puppeteer-core$": "<rootDir>/__mocks__/puppeteer-core.js",
    "^@aws-sdk/client-s3$": "<rootDir>/__mocks__/@aws-sdk/client-s3.js",
  },
  verbose: true,
   haste: { enableSymlinks: false },
};
