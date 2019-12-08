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
const watcher = new watchRuntime(api, client);

// load settings from redis
// is the redis server in a default state?  if so, init with defaults
getAsync('watch-lb-settings').then((res) => {
  if (!res) {
    // initialize matching
    console.log("Initializing from defaults");
    watcher.saveSettings();
  } else {
    var loaded = JSON.parse(res);
    // merge with our settings
    for (setting in savedSettings) {
      if (typeof loaded[setting] != 'undefined') {
        // TODO: treat 'matching' as its own merge?
        // upside: adding new defaults go in on reboot
        // downside: removing and rebooting brings it back
        // maybe better: /list default command to reset redis
        savedSettings[setting] = loaded[setting];
      }
    }
    // manually upconvert known Dates
    savedSettings.lastMD5Update = (savedSettings.lastMD5Update == null) ? null : new Date(savedSettings.lastMD5Update);
    savedSettings.lastIntervalUpdate = (savedSettings.lastIntervalUpdate == null) ? null : new Date(savedSettings.lastIntervalUpdate);
  }

  // now we have master settings, continue with booting

  // just do a test run?
  if (!runOnce) {
    console.log("defaultRate is " + savedSettings.defaultRate);
    if (!savedSettings.defaultRate) {
      savedSettings.defaultRate = process.env.CHECK_RATE || DEFAULT_RATE;
      saveSettings();
    }
    runtimeSettings.intervalTimer = setInterval(checkWines, 1000 * 60 * savedSettings.defaultRate);
  }

  // does it look like the system just started?
  if (os.uptime() < 5 * 60) {
    sendMessage("Looks like the system just restarted, uptime is " + os.uptime());
  }

  // just in case, run an initial check.  with all of the caching we're doing, 
  // we should not be over-communicating
  checkWines();
});
