/* eslint-disable */

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

try {
    const isWindows = OS === 'win32' || OS === 'win64';
    const os = isWindows ? 'win32' : 'nix';
    runCommands[os][arg]();
} catch (error) {
    shell.echo(error);
}
