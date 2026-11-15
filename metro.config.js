const path = require('path');
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

// The Anthropic SDK's ES-module build has a circular import that Metro cannot load
// ("Cannot read property 'BetaToolRunner' of undefined"). Its CommonJS build is fine.
const ANTHROPIC_SDK = path.join(__dirname, 'node_modules/@anthropic-ai/sdk/index.js');

config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (moduleName === '@anthropic-ai/sdk') return { type: 'sourceFile', filePath: ANTHROPIC_SDK };
  return context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
