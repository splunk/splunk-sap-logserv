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

// Build 302 / session 092 — app version + build number, read from the
// SHIPPED app.conf at compile time and baked into the bundle by
// DefinePlugin (surfaced as APP_VERSION / APP_BUILD in buildFlags.ts and
// displayed by the About modal).
//
// Derived, never typed: app.conf is the single source of truth that the
// release process already bumps, so the About dialog cannot drift from
// the installed app the way a hand-maintained string does. (Build 301
// had to sweep a hard-coded "48" out of five places for exactly that
// reason.) Parsed here rather than imported so no conf parser ships in
// the browser bundle.
const readAppConfValue = (section, key) => {
    const confPath = path.join(__dirname, 'src/main/resources/splunk/default/app.conf');
    const text = fs.readFileSync(confPath, 'utf8');
    let current = null;
    for (const rawLine of text.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#')) continue;
        const sectionMatch = line.match(/^\[([^\]]+)\]$/);
        if (sectionMatch) {
            current = sectionMatch[1];
            continue;
        }
        if (current !== section) continue;
        const kv = line.match(/^([^=]+?)\s*=\s*(.*)$/);
        if (kv && kv[1] === key) return kv[2].trim();
    }
    // Fail the build rather than silently shipping an empty About dialog.
    throw new Error(
        `webpack.config.js: could not read [${section}] ${key} from ${confPath}`,
    );
};

const APP_VERSION = readAppConfValue('id', 'version');
const APP_BUILD = readAppConfValue('install', 'build');

// Build 303 — the date this bundle was compiled, as UTC `YYYY-MM-DD`.
//
// DATE ONLY, deliberately: two builds made on the same day produce the
// same string, so the bundle stays byte-comparable within a day (the
// build-300 verification diffed the templates-only and full-LLM bundles
// and relied on their differences being confined to the compile flag and
// styled-components' salt — a full timestamp would have added a third
// differing region). Disambiguating two builds from the same day is what
// the build NUMBER is for; the date is context for a human reading the
// About dialog. UTC so it doesn't shift with the builder's timezone.
const APP_BUILD_DATE = new Date().toISOString().slice(0, 10);

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
                // Build 302 / 303 — see readAppConfValue + APP_BUILD_DATE above.
                'process.env.LOGSERV_APP_VERSION': JSON.stringify(APP_VERSION),
                'process.env.LOGSERV_APP_BUILD': JSON.stringify(APP_BUILD),
                'process.env.LOGSERV_APP_BUILD_DATE': JSON.stringify(APP_BUILD_DATE),
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
