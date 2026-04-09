import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startApp, stopApp } from './helpers/app-launcher.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WEBDRIVER_PORT = 4445;

export const config = {
  runner: 'local',
  specs: [resolve(__dirname, 'specs', '*.spec.js')],
  exclude: [],
  maxInstances: 1,

  capabilities: [{
    browserName: 'chrome',
    'goog:chromeOptions': {},
  }],

  hostname: '127.0.0.1',
  port: WEBDRIVER_PORT,
  path: '/',

  logLevel: 'warn',
  bail: 0,
  waitforTimeout: 10000,
  connectionRetryTimeout: 120000,
  connectionRetryCount: 3,

  framework: 'mocha',
  reporters: ['spec'],

  mochaOpts: {
    ui: 'bdd',
    timeout: 60000,
  },

  onPrepare: async function () {
    console.log('Starting Markdown Desk (debug)...');
    await startApp(WEBDRIVER_PORT);
  },

  onComplete: function () {
    console.log('Stopping Markdown Desk...');
    stopApp(WEBDRIVER_PORT);
  },
};
