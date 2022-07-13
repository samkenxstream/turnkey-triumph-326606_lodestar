const webpack = require("webpack");
const ResolveTypeScriptPlugin = require("resolve-typescript-plugin");

module.exports = {
  mode: "development",
  target: "web",
  experiments: {
    topLevelAwait: true,
  },
  plugins: [
    new webpack.ProvidePlugin({
      process: "process/browser.js",
      Buffer: ["buffer", "Buffer"],
    }),
  ],
  module: {
    rules: [
      {
        test: /\.ts?$/,
        use: [
          {
            loader: "ts-loader",
            options: {
              configFile: "tsconfig.build.json",
            },
          },
        ],
        exclude: [/node_modules/],
      },
    ],
  },
  resolve: {
    plugins: [new ResolveTypeScriptPlugin()],
    extensions: [".ts", ".js"],
    fallback: {
      crypto: require.resolve("crypto-browserify"),
      path: require.resolve("path-browserify"),
      fs: false,
      os: false,
      zlib: require.resolve("browserify-zlib"),
      stream: require.resolve("stream-browserify"),
      http: require.resolve("stream-http"),
      https: require.resolve("https-browserify"),
    },
  },
};
