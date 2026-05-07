const fs = require('fs');
const path = require('path');
const webpack = require('webpack');
const CopyWebpackPlugin = require('copy-webpack-plugin');
const { merge: webpackMerge } = require('webpack-merge');
const baseConfig = require('@splunk/webpack-configs/base.config').default;

// Build-time flag — when set to "true" via the environment, the compiled
// bundle has the AI Assistant's free-form / LLM-driven flow disabled. The
// canned-prompt + MCP path stays fully functional. Used to ship a
// templates-only variant of the app for partner / restricted-environment
// testing where no LLM dispatch is allowed. Build 173 / session 029.
//
// Usage: `LOGSERV_TEMPLATES_ONLY=true yarn build` (also exposed as the
// `build:templates-only` npm script in package.json).
//
// The value is consumed via `buildFlags.ts` which reads
// `process.env.LOGSERV_TEMPLATES_ONLY === 'true'` at use sites; webpack
// substitutes the string literal here at compile time, so the guard is
// dead-code-eliminated in the regular build (no runtime cost).
const TEMPLATES_ONLY_FLAG = process.env.LOGSERV_TEMPLATES_ONLY === 'true';

const entries = fs
    .readdirSync(path.join(__dirname, 'src/main/webapp/pages'))
    .filter((pageFile) => !/^\./.test(pageFile))
    .reduce((accum, page) => {
        accum[page] = path.join(__dirname, 'src/main/webapp/pages', page);
        return accum;
    }, {});

module.exports = (_env, argv) => {
    const isProduction = argv && argv.mode === 'production';

    return webpackMerge(baseConfig, {
        entry: entries,
        output: {
            path: path.join(__dirname, 'stage/appserver/static/pages/'),
            filename: '[name].js',
        },
        plugins: [
            new CopyWebpackPlugin({
                patterns: [
                    {
                        from: path.join(__dirname, 'src/main/resources/splunk'),
                        to: path.join(__dirname, 'stage'),
                    },
                ],
            }),
            // Replace `process.env.LOGSERV_TEMPLATES_ONLY` with the
            // string literal "true" or "false" at compile time. Used by
            // src/main/webapp/pages/home/buildFlags.ts to expose a typed
            // boolean to the rest of the app. Build 173.
            new webpack.DefinePlugin({
                'process.env.LOGSERV_TEMPLATES_ONLY': JSON.stringify(
                    TEMPLATES_ONLY_FLAG ? 'true' : 'false',
                ),
            }),
        ],
        devtool: isProduction ? false : 'eval-source-map',
        module: {
            // style-loader injects CSS via runtime <style> tags; css-loader
            // resolves @import + url() in the file. Without style-loader the
            // CSS is processed but never reaches the DOM (silent no-op),
            // which is how `import '@xyflow/react/dist/style.css'` was being
            // dropped before — see SESSION-MEMORY-023.md.
            rules: [{ test: /\.css$/, use: ['style-loader', 'css-loader'] }],
        },
    });
};
