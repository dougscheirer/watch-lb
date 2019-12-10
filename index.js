// .env reader
require('dotenv').config()
const curl = new (require('curl-request'))();
const parser = require('node-html-parser');
const telegram = require('node-telegram-bot-api');
const crypto = require('crypto');
const os = require('os');
const mjs = require('moment');
const redis = require("redis");
const { promisify } = require('util');
const durationParser = require('parse-duration');
const { watchRuntime } = require('./functions');

// determine redis host from environment and connect
const opts = { host: process.env.REDIS_HOST || "localhost", port: process.env.REDIS_PORT || 6379 };
const client = redis.createClient(opts);

// connect to telegram
const api = new telegram(process.env.API_TOKEN, { polling: true });

// now create our runtime
const watcher = new watchRuntime(api, client, process.env.CHAT_ID);

watcher.loadSettings().then((res) => {
  // does it look like the system just started?
  if (os.uptime() < 5 * 60) {
    watcher.sendMessage("Looks like the system just restarted, uptime is " + os.uptime());
  }

  // just in case, always run an initial check.  with all of the caching we're doing, 
  // we should not be over-communicating
  watcher.checkWines();
});
