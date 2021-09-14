const chalk = require('chalk');
const fs = require('fs');
const path = require('path');
const archiver = require('archiver');
const tmp = require('tmp');
const Spinnies = require('spinnies');
const {
  addAccountOptions,
  addConfigOptions,
  setLogLevel,
  getAccountId,
  addUseEnvironmentOptions,
} = require('../../lib/commonOpts');
const { trackCommandUsage } = require('../../lib/usageTracking');
const { logDebugInfo } = require('../../lib/debugInfo');
const {
  loadConfig,
  validateConfig,
  checkAndWarnGitInclusion,
} = require('@hubspot/cli-lib');
const {
  logApiErrorInstance,
  ApiErrorContext,
} = require('@hubspot/cli-lib/errorHandlers');
const { logger } = require('@hubspot/cli-lib/logger');
const { uploadProject } = require('@hubspot/cli-lib/api/dfs');
const { shouldIgnoreFile } = require('@hubspot/cli-lib/ignoreRules');
const { getCwd } = require('@hubspot/cli-lib/path');
const { validateAccount } = require('../../lib/validation');
const {
  getProjectConfig,
  validateProjectConfig,
  pollBuildStatus,
} = require('../../lib/projects');

const loadAndValidateOptions = async options => {
  setLogLevel(options);
  logDebugInfo(options);
  const { config: configPath } = options;
  loadConfig(configPath, options);
  checkAndWarnGitInclusion();

  if (!(validateConfig() && (await validateAccount(options)))) {
    process.exit(1);
  }
};

exports.command = 'upload [path]';
exports.describe = false;

const uploadProjectFiles = async (accountId, projectName, filePath) => {
  const spinnies = new Spinnies();

  spinnies.add('upload', {
    text: `Uploading ${chalk.bold(projectName)} project files to ${chalk.bold(
      accountId
    )}`,
  });

  try {
    const upload = await uploadProject(accountId, projectName, filePath);

    spinnies.succeed('upload', {
      text: `Uploaded ${chalk.bold(projectName)} project files to ${chalk.bold(
        accountId
      )}`,
    });

    logger.debug(
      `Project "${projectName}" uploaded and build #${upload.buildId} created`
    );
    await pollBuildStatus(accountId, projectName, upload.buildId);
  } catch (err) {
    if (err.statusCode === 404) {
      return logger.error(
        `Project '${projectName}' does not exist. Try running 'hs project init' first.`
      );
    }

    spinnies.fail('upload', {
      text: `Failed to upload ${chalk.bold(
        projectName
      )} project files to ${chalk.bold(accountId)}`,
    });

    logApiErrorInstance(err, {
      context: new ApiErrorContext({
        accountId,
        projectName,
      }),
    });
  }
};

exports.handler = async options => {
  loadAndValidateOptions(options);

  const { path: projectPath } = options;
  const accountId = getAccountId(options);

  trackCommandUsage('project-upload', { projectPath }, accountId);

  const cwd = projectPath ? path.resolve(getCwd(), projectPath) : getCwd();
  const projectConfig = await getProjectConfig(cwd);

  validateProjectConfig(projectConfig);

  const tempFile = tmp.fileSync({ postfix: '.zip' });

  logger.debug(`Compressing build files to '${tempFile.name}'`);

  const output = fs.createWriteStream(tempFile.name);
  const archive = archiver('zip');

  output.on('close', async function() {
    logger.debug(`Project files compressed: ${archive.pointer()} bytes`);

    await uploadProjectFiles(accountId, projectConfig.name, tempFile.name);

    try {
      tempFile.removeCallback();
      logger.debug(`Cleaned up temporary file ${tempFile.name}`);
    } catch (e) {
      logger.error(e);
    }
  });

  archive.on('error', function(err) {
    throw err;
  });

  archive.pipe(output);

  archive.directory(path.resolve(cwd, projectConfig.srcDir), false, file =>
    shouldIgnoreFile(file.name) ? false : file
  );

  archive.finalize();
};

exports.builder = yargs => {
  yargs.positional('path', {
    describe: 'Path to a project folder',
    type: 'string',
  });

  yargs.example([['$0 project upload myProjectFolder', 'Upload a project']]);

  addConfigOptions(yargs, true);
  addAccountOptions(yargs, true);
  addUseEnvironmentOptions(yargs, true);

  return yargs;
};