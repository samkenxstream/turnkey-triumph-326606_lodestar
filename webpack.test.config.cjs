const webpack = require("webpack");
const ResolveTypeScriptPlugin = require("resolve-typescript-plugin");

module.exports = {
  mode: "development",
  experiments: {
    topLevelAwait: true,
  },
  // devtool: "eval-source-map",
  stats: {
    errorDetails: true,
  },
  plugins: [
    new webpack.ProvidePlugin({
      process: "process/browser.js",
      Buffer: ["buffer", "Buffer"],
    }),
  ],
  module: {
    exprContextCritical: false,
    rules: [
      {
        test: /\.ts?$/,
        use: [
          {
            loader: "ts-loader",
            options: {
              configFile: "tsconfig.e2e.json",
              experimentalFileCaching: true,
              transpileOnly: true,
              projectReferences: true,
            },
          },
        ],
        exclude: [/node_modules/],
      },
    ],
  },
  resolve: {
    plugins: [
      new ResolveTypeScriptPlugin({includeNodeModules: false}),
      // new webpack.IgnorePlugin({
      //   resourceRegExp: /.*js$/,
      //   contextRegExp: /.*@chainsafe\/blst\/.*/,
      // }),
    ],
    fallback: {
      "@chainsafe/blst": false,
      path: false,
      fs: false,
      os: false,
      zlib: false,
      stream: false,
      http: require.resolve("stream-http"),
      http2: require.resolve("stream-http"),
      https: require.resolve("https-browserify"),
      crypto: require.resolve("crypto-browserify"),
    },
  },
};
