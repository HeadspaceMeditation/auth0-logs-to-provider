const moment = require('moment');
const loggingTools = require('auth0-log-extension-tools');

const senders = require('./senders');
const logger = require('./logger');
const config = require('./config');

const MS_PER_S = 1000;
const NS_PER_MS = 1000000;

module.exports = (storage) =>
  (req, res, next) => {
    const wtBody = (req.webtaskContext && req.webtaskContext.body) || req.body || {};
    const wtHead = (req.webtaskContext && req.webtaskContext.headers) || {};
    const isCron = (wtBody.schedule && wtBody.state === 'active') || (wtHead.referer === 'https://manage.auth0.com/' && wtHead['if-none-match']);

    if (!isCron) {
      return next();
    }

    const updateLastRun = () =>
      storage.read()
        .then(data => {
          data.lastRun = new Date();
          return storage.write(data);
        });

    const provider = config('PROVIDER');

    if (!provider || !senders[provider]) {
      throw new Error(`Unknown provider: ${provider}`);
    }

    const sendLogs = senders[provider]();

    const onLogsReceived = (logs, callback) => {
      const startTime = process.hrtime();

      const requestFinished = (err) => {
        const elapsedTime = process.hrtime(startTime);
        const elapsedMillis = elapsedTime[0] * MS_PER_S + elapsedTime[1] / NS_PER_MS;

        logger.info(`Finished request to '${provider}' in ${elapsedMillis}ms.`);

        callback(err);
      };

      sendLogs(logs, requestFinished);
    };

    const slack = new loggingTools.reporters.SlackReporter({
      hook: config('SLACK_INCOMING_WEBHOOK_URL'),
      username: `auth0-logs-to-${provider}`,
      title: 'Logs Export'
    });

    const options = {
      domain: config('AUTH0_DOMAIN'),
      clientId: config('AUTH0_CLIENT_ID'),
      clientSecret: config('AUTH0_CLIENT_SECRET'),
      batchSize: parseInt(config('BATCH_SIZE')),
      startFrom: config('START_FROM'),
      logTypes: config('LOG_TYPES'),
      logLevel: config('LOG_LEVEL'),
      logger
    };

    const maxBatchSize = (provider === 'mixpanel') ? 20 : 100;

    if (!options.batchSize || options.batchSize > maxBatchSize) {
      options.batchSize = maxBatchSize;
    }

    if (options.logTypes && !Array.isArray(options.logTypes)) {
      options.logTypes = options.logTypes.replace(/\s/g, '').split(',');
    }

    const auth0logger = new loggingTools.LogsProcessor(storage, options);

    const sendDailyReport = (lastReportDate) => {
      const current = new Date();

      const end = current.getTime();
      const start = end - 86400000;
      auth0logger.getReport(start, end)
        .then(report => slack.send(report, report.checkpoint))
        .then(() => storage.read())
        .then((data) => {
          data.lastReportDate = lastReportDate;
          return storage.write(data);
        });
    };

    const checkReportTime = () => {
      storage.read()
        .then((data) => {
          const now = moment().format('DD-MM-YYYY');
          const reportTime = config('DAILY_REPORT_TIME') || 16;

          if (data.lastReportDate !== now && new Date().getHours() >= reportTime) {
            sendDailyReport(now);
          }
        })
    };

    return updateLastRun()
      .then(() => auth0logger
        .run(onLogsReceived)
        .then(result => {
          if (result && result.status && result.status.error) {
            slack.send(result.status, result.checkpoint);
          } else if (config('SLACK_SEND_SUCCESS') === true || config('SLACK_SEND_SUCCESS') === 'true') {
            slack.send(result.status, result.checkpoint);
          }
          checkReportTime();
          res.json(result);
        })
        .catch(err => {
          slack.send({ error: err, logsProcessed: 0 }, null);
          checkReportTime();
          next(err);
        }));
  };