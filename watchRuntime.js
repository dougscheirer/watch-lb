require('dotenv').config();
const curl = new (require('curl-request'))();
const parser = require('node-html-parser');
const crypto = require('crypto');
const mjs = require('moment');
const redis = require("redis");
const { promisify } = require('util');
const durationParser = require('parse-duration');
const fs = require('fs');

const DEFAULT_RATE = 15;

// only do whole word matching
const matching_default = [
  "bordeaux",
  "mounts",
  "trespass",
  "cabernet",
  "franc",
  "rioja",
  "syrah",
  "emilion",
  "les ormes",
  "petit"];

function watchRuntime(telegramApi, redisApi, chatid) {
  if (!telegramApi)
    throw new Error("telegramApi is required");
  if (!redisApi)
     throw new Error("redis client is required");
  if (!chatid) 
    chatid = process.env.CHAT_ID;
  
  this.telegramApi = telegramApi,
    this.client = redisApi,
    this.chatid = chatid,
    this.getAsync = promisify(this.client.get).bind(this.client),
    this.logger = console.log,

    this.runtimeSettings = {
      intervalTimer: null,
    },

    this.savedSettings = {
      lastMD5: null,
      lastMD5Update: null,
      lastIntervalUpdate: null,
      sent24hrMessage: false,
      matching: matching_default.slice(),
      defaultRate: null,
      pauseUntil: -1
    },

    this.saveSettings = () => {
      this.client.set('watch-lb-settings', JSON.stringify(this.savedSettings));
    },

    this.sendList = () => {
      this.sendMessage("Current search terms:\n" + this.savedSettings.matching.join("\n"));
    },

    this.handleStart = (msg) => {
      const chatId = msg.chat.id;

      this.sendMessage("Your chat id is " + chatId);
    },

    // /list
    this.handleList = (msg) => {
      this.sendList();
    },

    // /list default
    this.handleListDefault = (msg) => {
      this.savedSettings.matching = matching_default.slice();
      this.saveSettings();
      this.logger("Restored default list");
      this.sendList();
    },

    // /status
    this.handleStatus = (msg) => {
      const duration = mjs.duration(this.savedSettings.lastIntervalUpdate - this.savedSettings.lastMD5Update);
      var msgResp = "Never checked\n";
      if (this.savedSettings.lastMD5Update != null) {
        msgResp = "Last check at " + this.savedSettings.lastIntervalUpdate + "\n";
        msgResp += "Last difference at " + this.savedSettings.lastMD5Update + " (" + duration.humanize() + ")\n";
      }
      msgResp += "Current interval: " + mjs.duration(this.savedSettings.defaultRate * 1000 * 60).humanize();
      try {
        if (this.savedSettings.pauseUntil != -1) {
         msgResp += "\nPaused until " + ((this.savedSettings.pauseUntil > 0) ? this.savedSettings.pauseUntil : "forever");
       }
      } catch (e) {
        this.logger(e);
      }
      try {
	const contents = fs.readFileSync('./git-head.txt', 'utf8');
	msgResp += "\n" + contents;
      } catch(e) {
	msgResp += "\ngit: intermediate build";
      }
      this.sendMessage(msgResp);
      this.logger(msg);
      this.logger(msg.chat);
    },

    // /add (term)
    this.handleAdd = (msg, match) => {
      const toAdd = match[1].toLowerCase();
      if (this.savedSettings.matching.indexOf(toAdd) >= 0) {
        this.sendMessage(toAdd + " is already a search term");
        return;
      }
      this.savedSettings.matching.push(toAdd);
      this.sendList();
      // invalidate the MD5 cache
      this.savedSettings.lastMD5 = null;
      this.savedSettings.lastMD5Update = null;
      // write to redis
      this.saveSettings();
      this.checkWines(true);
    },

    // /del (term)
    this.handleDelete = (msg, match) => {
      const toDel = match[1].toLowerCase();
      if (this.savedSettings.matching.indexOf(toDel) < 0) {
        this.sendMessage(toDel + " is not a search term");
        return;
      }
      this.savedSettings.matching = this.savedSettings.matching.splice(toDel, 1);
      this.sendList();
      // write to redis
      this.saveSettings();
      // invalidate the MD5 cache
      this.savedSettings.lastMD5 = null;
      this.savedSettings.lastMD5Update = null;
      // write to redis
      this.saveSettings();
      this.checkWines(true);
    },

    // /now
    this.handleNow = (msg) => {
      this.checkWines(true);
    },

    // /uptick (human-readable time | default)"
    this.handleUptick = (msg, match) => {
      var number = null;
      if (match[1] == "default") {
        number = DEFAULT_RATE;
      } else {
        // if only numbers, then assume it's in minutes
        const reg = /^\d+$/;
        if (reg.test(match[1])) {
          number = parseInt(match[1]);
        } else {
          // try to parse a duration string (comes out in ms) and convert to minutes
          number = (durationParser(match[1])) / (60 * 1000);
        }
      }

      if (number < 1) {
        this.sendMessage(match[1] + " is not a valid number.  Specify a number of minutes or duration (e.g. 1h) to change the check interval");
        return;
      }

      // change the frequency of checks to (match) minutes
      clearInterval(this.runtimeSettings.intervalTimer);
      this.checkWines();
      this.runtimeSettings.intervalTimer = setInterval(this.checkWines, number * 1000 * 60);
      // save the last setting
      this.savedSettings.defaultRate = number;
      this.saveSettings();
      this.sendMessage("Check interval changed to " + mjs.duration(number * 1000 * 60).humanize());
    },

    this.handlePause = (msg, match) => {
      var until = 0;
      if (match.length == 1) {
        // just pause, no end time
      } else {
        // if only numbers, then assume it's in minutes
        const reg = /^\d+$/;
        if (reg.test(match[1])) {
          until = parseInt(match[1]) * 60 * 1000;
        } else {
          // try to parse a duration string (comes out in ms) and convert to minutes
          until = durationParser(match[1]);
        }
      }
      // write the until time as 0 (forever) or a datestamp
      if (until > 0) {
        until = new Date((new Date()).getTime() + until);
      }
      this.savedSettings.pauseUntil = until;
      this.saveSettings();
      this.sendMessage("Pausing until " + ((until > 0) ? until : "forever"));
    },

    this.handleResume = (msg) => {
      this.savedSettings.pauseUntil = -1;
      this.saveSettings();
      this.sendMessage("Resuming with check interval of " + mjs.duration(this.savedSettings.defaultRate * 1000 * 60).humanize());
    },

    this.handleSettings = (msg) => {
      this.sendMessage(JSON.stringify(this.savedSettings));
    },
    
    this.logError = async (message) => {
      this.logger("ERROR >>>");
      this.logger(message);
      await this.sendMessage(message);
    },

    this.sendMessage = async (message) => {
      this.logger("Sending message to " + this.chatid + " : " + message);
      return telegramApi.sendMessage(this.chatid, message);
    },

    // allow for fetchUrl to be overridden in test mode
    this.fetchUrl = (url) => {
      return curl.get(url);
    },

    this.checkWines = (reportNothing) => {
      this.savedSettings.lastIntervalUpdate = new Date();
      if (this.savedSettings.pauseUntil == 0) {
        if (reportNothing) {
          this.sendMessage("Paused, use /resume to restart");
        }
        return; // we're paused
      } else if (this.savedSettings.pauseUntil != -1) {
        if (this.savedSettings.lastIntervalUpdate > this.savedSettings.pauseUntil) {
          this.savedSettings.pauseUntil = -1;
          this.saveSettings();
        } else {
          if (reportNothing) {
            this.sendMessage("Paused, will resume on " + this.savedSettings.pauseUntil);
          }
          return; // we're paused
        }
      }
      this.fetchUrl("https://lastbottlewines.com")
        .then(({ statusCode, body, headers }) => {
          if (statusCode != 200) {
            this.logError("Fetch error: " + statusCode);
            return;
          }

          // parse the body and look for the offer-name class
          const root = parser.parse(body);
          // catch parse errors?  I think those just end up as roots with no data
          const offerName = root.querySelector(".offer-name");
          if (!offerName) {
            this.logError("offer-name class not found, perhaps the page formatting has changed or there was a page load error");
            return;
          }

          // write hash to a local FS to tell when page has changed?
          const hash = crypto.createHash('md5').update(body).digest("hex");
          if (!reportNothing && hash == this.savedSettings.lastMD5) {
            this.logger("No changes since last update");
            if (this.savedSettings.lastMD5Update != null) {
              this.logger("Time since last change: " + ((new Date()) - this.savedSettings.lastMD5Update));
              // how long since it changed?  are we not getting updates?
              if (!this.savedSettings.sent24hrMessage && ((new Date()) - this.savedSettings.lastMD5Update) > 24 * 60 * 60 * 1000) {
                this.savedSettings.sent24hrMessage = true;
                this.sendMessage("No updates for more than 24h");
                this.saveSettings();
              }
            }
            return;
          }

          // remember the MD5 and if we have sent our message
          this.savedSettings.sent24hrMessage = false;
          this.savedSettings.lastMD5 = hash;
          this.savedSettings.lastMD5Update = new Date();
          this.saveSettings();

          for (var name in this.savedSettings.matching) {
            if (body.match(new RegExp("\\b" + this.savedSettings.matching[name] + "\\b", "i"))) {
              const that = this;
	            this.sendMessage("Found a match for " + this.savedSettings.matching[name] + " in " + offerName.rawText + "\nhttps://lastbottlewines.com")
                .then(function (data) {
                  that.logger("We got some data");
                  that.logger(data);
                })
                .catch(function (err) {
                  that.logError(err);
                });
              return;
            }
          }
          if (!!reportNothing)
            this.sendMessage("No matching terms in '" + offerName.rawText + "'");
            this.logger("No matching terms for '" + offerName.rawText + "'");
        })
        .catch((e) => {
          this.logger(e);
        });
    },

    /* jshint expr: true */
    this.loadSettings = async (start) => {
      return this.getAsync('watch-lb-settings').then((res) => {
        if (!res) {
          // initialize matching
          this.logger("Initializing from defaults");
          this.saveSettings();
        } else {
          var loaded = JSON.parse(res);
          // merge with our settings
          for (var setting in this.savedSettings) {
            if (typeof loaded[setting] != 'undefined') {
              // TODO: treat 'matching' as its own merge?
              // upside: adding new defaults go in on reboot
              // downside: removing and rebooting brings it back
              // maybe better: /list default command to reset redis
              this.savedSettings[setting] = loaded[setting];
            }
          }
          // manually upconvert known Dates
          this.savedSettings.lastMD5Update = (this.savedSettings.lastMD5Update == null) ? null : new Date(this.savedSettings.lastMD5Update);
          this.savedSettings.lastIntervalUpdate = (this.savedSettings.lastIntervalUpdate == null) ? null : new Date(this.savedSettings.lastIntervalUpdate);
        }

        this.logger("Settings:");
        this.logger(this.savedSettings);

        // now we have master settings, continue with booting
        if (!this.savedSettings.defaultRate) {
          this.savedSettings.defaultRate = process.env.CHECK_RATE || DEFAULT_RATE;
          this.saveSettings();
        }
        if (start == undefined || !!start) {
          this.runtimeSettings.intervalTimer = setInterval(this.checkWines, 1000 * 60 * this.savedSettings.defaultRate);
        }
      });
    };

  // load up all of the text processors

  // /start
  telegramApi.onText(/\/start$/, this.handleStart);
  // /list
  telegramApi.onText(/\/list$/, this.handleList);
  // /list default
  telegramApi.onText(/\/list default$/, this.handleListDefault);
  // /status
  telegramApi.onText(/\/status$/, this.handleStatus);
  // /add (term)
  telegramApi.onText(/\/add (.+)/, this.handleAdd);
  // /del (term)
  telegramApi.onText(/\/del (.+)/, this.handleDelete);
  // /now
  telegramApi.onText(/\/now$/, this.handleNow);
  // /uptick (human-readable time | default)"
  telegramApi.onText(/\/uptick (.+)/, this.handleUptick);
  // /pause [human-readable time]
  telegramApi.onText(/\/pause$/, this.handlePause);
  telegramApi.onText(/\/pause (.+)/, this.handlePause);
  // /resume
  telegramApi.onText(/\/resume$/, this.handleResume);
  // /help
  telegramApi.onText(/\/help$/, () => {
    this.sendMessage("Commands:\n" +
      "/start\n" +
      "/list [default]\n" +
      "/status\n" +
      "/add (term)\n" +
      "/del (term)\n" +
      "/now\n" +
      "/uptick (duration | default)\n" +
      "/pause [duration]\n" +
      "/resume\n" +
      "/help");
  });
  // /settings
  telegramApi.onText(/\/settings$/, this.handleSettings);
}

exports.watchRuntime = watchRuntime;
