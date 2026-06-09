import { readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startApp, stopApp } from './helpers/app-launcher.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WEBDRIVER_PORT = 4445;

// auto-refresh-cold-start.spec.js 는 Welcome 탭 race 가드를 위해 매 it
// 마다 새 tmpdir 를 만들고 Rust 측 WatcherState 에 path 를 add_file 한다.
// WatcherState 는 path entry 를 세션 안에서 누적하므로, cold-start 는 이제
// beforeEach 에서 reset_watcher IPC(commands.rs)로 매번 watch 를 비워 각
// 시나리오를 누적/교차오염에서 격리한다. 다만 reset 은 beforeEach(테스트
// 시작 전)라 spec 종료 시점엔 마지막 테스트의 watch 가 남는다 → cold-start
// 를 가장 마지막에 두어 그 잔여 state 가 후속 spec 으로 새지 않게 한다
// (defense-in-depth). 다른 spec 들은 alphabetical 순서를 유지한다.
const SPECS_DIR = resolve(__dirname, 'specs');
const COLD_START_SPEC = 'auto-refresh-cold-start.spec.js';
const allSpecs = readdirSync(SPECS_DIR)
  .filter((f) => f.endsWith('.spec.js'))
  .sort();
const orderedSpecs = [
  ...allSpecs.filter((f) => f !== COLD_START_SPEC),
  ...(allSpecs.includes(COLD_START_SPEC) ? [COLD_START_SPEC] : []),
].map((f) => resolve(SPECS_DIR, f));

export const config = {
  runner: 'local',
  specs: orderedSpecs,
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
