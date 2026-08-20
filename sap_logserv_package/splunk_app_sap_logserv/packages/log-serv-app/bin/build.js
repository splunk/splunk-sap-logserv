/* eslint-disable */

const fs = require('fs');
const path = require('path');
const shell = require('shelljs');
const OS = require('os').platform().toLocaleLowerCase();

const arg = process.argv[2];
const flagArgs = process.argv.slice(3);
const commands = ['build', 'link'];

if (!arg) {
    shell.echo(
        `No command received, please supply a command to run. \nCommands: ${commands.join(', ')}`
    );
    shell.exit(1);
}

if (!commands.includes(arg)) {
    shell.echo(`Please supply one of the following command to run: ${commands.join(', ')}`);
    shell.exit(1);
}

// Build 173 — accept a `--templates-only` flag so the npm script
// `build:templates-only` works cross-platform without needing
// `cross-env` or a Windows-specific env-var prefix in package.json.
// shelljs.exec() inherits process.env by default, so setting it here
// before the exec is enough — webpack's DefinePlugin reads it via
// process.env at config-load time.
if (flagArgs.includes('--templates-only')) {
    process.env.LOGSERV_TEMPLATES_ONLY = 'true';
    shell.echo('-> templates-only build (LOGSERV_TEMPLATES_ONLY=true)');
}

const cleanStage = () => {
    shell.rm('-rf', 'stage');
};

// prettier-ignore
const runCommands = {
    win32: {
        build: () => {
            cleanStage();
            return shell.exec('set NODE_ENV=production&&.\\node_modules\\.bin\\webpack --mode=production');
        },
        link: () => shell.exec('mklink /D "%SPLUNK_HOME%\\etc\\apps\\splunk_app_sap_logserv" "%cd%\\stage"'),
    },
    nix: {
        build: () => {
            cleanStage();
            return shell.exec('export NODE_ENV=production && ./node_modules/.bin/webpack --mode=production');
        },
        link: () => shell.exec('ln -s $PWD/stage $SPLUNK_HOME/etc/apps/splunk_app_sap_logserv'),
    },
};

// Build 300 / session 092 — post-build patch of the STAGED conf.
//
// The compile-time flag alone cannot set an admin-visible default: the
// shipped `default/ai_assistant_settings.conf` is copied verbatim into
// stage/ by webpack's CopyPlugin. So in a templates-only build we rewrite
// the staged copy (never the source) so the artifact is self-describing —
// `btool`, the REST conf endpoint, and an admin reading the file all
// report `templates_only_mode = true`.
//
// NOTE this is belt-and-braces, not the enforcement mechanism. KV Store
// WINS over the conf at read time, so enforcement lives in the webapp at
// utils/aiConfigApi.ts (which forces the value true regardless of source).
// This patch keeps the shipped default honest and consistent with it.
//
// Tolerant regex + self-assert: if the conf's formatting ever drifts, or
// webpack didn't produce the file, the build FAILS loudly rather than
// silently shipping a templates-only bundle whose conf says otherwise.
const patchStagedTemplatesOnlyConf = () => {
    const CONF = path.resolve(
        __dirname, '..', 'stage', 'default', 'ai_assistant_settings.conf',
    );
    const KEY = 'templates_only_mode';
    const fail = (msg) => {
        shell.echo(`build: templates-only conf patch FAILED — ${msg}`);
        shell.exit(1);
    };

    if (!fs.existsSync(CONF)) {
        fail(`${CONF} not found (did webpack fail before the resource copy?)`);
    }

    const before = fs.readFileSync(CONF, 'utf8');
    const line = new RegExp(`^[ \\t]*${KEY}[ \\t]*=[ \\t]*(\\S+)[ \\t]*$`, 'gm');
    const matches = before.match(line) || [];
    if (matches.length !== 1) {
        fail(`expected exactly one \`${KEY} = ...\` line in ${CONF}, found ${matches.length}`);
    }

    const value = new RegExp(`^[ \\t]*${KEY}[ \\t]*=[ \\t]*(\\S+)[ \\t]*$`, 'm')
        .exec(before)[1];
    if (value !== 'true' && value !== 'false') {
        fail(`unexpected \`${KEY}\` value "${value}" — expected true or false`);
    }

    if (value === 'true') {
        shell.echo(`-> staged conf already has ${KEY} = true (no change)`);
        return;
    }

    const after = before.replace(line, `${KEY} = true`);
    fs.writeFileSync(CONF, after, 'utf8');

    // Re-read from disk and assert — never trust the in-memory result.
    const verify = fs.readFileSync(CONF, 'utf8');
    const verified = new RegExp(`^[ \\t]*${KEY}[ \\t]*=[ \\t]*(\\S+)[ \\t]*$`, 'm')
        .exec(verify);
    if (!verified || verified[1] !== 'true') {
        fail(`post-write verification failed — ${KEY} is not "true" on disk`);
    }
    shell.echo(`-> patched staged conf: ${KEY} = true`);
};

// Session 092 — propagate the command's exit code.
//
// This script used to discard the shelljs exec result and only echo on a
// thrown error, so it exited 0 even when webpack failed. The npm chain
// (`node bin/build.js build && yarn types:build && node bin/generate-sbom.js
// && node bin/generate-third-party-notices.js`) is `&&`-joined, so a failed
// compile still ran the remaining steps and reported a successful build —
// over a stage/ that cleanStage() had already emptied.
//
// shell.exit() is called AFTER the try/catch rather than inside it, so the
// control flow is explicit: a non-zero code stops the script before the
// templates-only conf patch below, which must never run on a failed build.
let result;
try {
    const isWindows = OS === 'win32' || OS === 'win64';
    const os = isWindows ? 'win32' : 'nix';
    result = runCommands[os][arg]();
} catch (error) {
    shell.echo(error);
    shell.exit(1);
}

if (result && typeof result.code === 'number' && result.code !== 0) {
    shell.echo(`build: '${arg}' failed with exit code ${result.code}`);
    shell.exit(result.code);
}

if (arg === 'build' && process.env.LOGSERV_TEMPLATES_ONLY === 'true') {
    patchStagedTemplatesOnlyConf();
}
