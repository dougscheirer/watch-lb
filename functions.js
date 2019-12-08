require('dotenv').config()
const curl = new (require('curl-request'))();
const parser = require('node-html-parser');
const crypto = require('crypto');
const mjs = require('moment');
const redis = require("redis");
const { promisify } = require('util');
const durationParser = require('parse-duration');

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

function watchRuntime(telegramApi, redisApi) {
  if (telegramApi) {
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
  }
  
  this.api = telegramApi,
    this.client = redisApi,
    this.getAsync = promisify(client.get).bind(client),

    this.runtimeSettings = {
      intervalTimer: null,
    },

    this.savedSettings = {
      lastMD5: null,
      lastMD5Update: null,
      lastIntervalUpdate: null,
      sent24hrMessage: false,
      matching: matching_default,
      defaultRate: null
    },

    this.saveSettings = () => {
      this.client.set('watch-lb-settings', JSON.stringify(savedSettings));
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
      this.savedSettings.matching = matching_default;
      this.saveSettings();
      console.log("Restored default list");
      this.sendList();
    },

    // /status
    this.handleStatus = (msg) => {
      const duration = mjs.duration(savedSettings.lastIntervalUpdate - savedSettings.lastMD5Update);
      var msgResp = "Never checked";
      if (this.savedSettings.lastMD5Update != null) {
        msgResp = "Last check at " + this.savedSettings.lastIntervalUpdate + "\n";
        msgResp += "Last difference at " + this.savedSettings.lastMD5Update + " (" + duration.humanize() + ")\n";
      }
      msgResp += "Current interval: " + mjs.duration(this.savedSettings.defaultRate);
      sendMessage(msgResp);
      console.log(msg);
      console.log(msg.chat);
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
    this.handleDelelte = (msg, match) => {
      const toDel = match[1].toLowerCase();
      if (this.savedSettings.matching.indexOf(toDel) < 0) {
        this.sendMessage(toDel + " is not a search term");
        return;
      }
      this.savedSettings.matching.splice(toDel, 1);
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
      clearInterval(runtimeSettings.intervalTimer);
      this.checkWines();
      this.runtimeSettings.intervalTimer = setInterval(checkWines, number * 1000 * 60);
      // save the last setting
      savedSettings.defaultRate = number;
      this.saveSettings();
      this.sendMessage("Check interval changed to " + number + " minutes");
    },

    this.logError = (message) => {
      console.log("ERROR >>>");
      console.log(message);
      this.sendMessage(message);
    },

    this.sendMessage = (message) => {
      console.log("Sending message: " + message);
      return (api) ? api.sendMessage(process.env.CHAT_ID, message) : console.log("No API, just logging");
    },

    this.checkWines = (reportNothing) => {
      this.savedSettings.lastIntervalUpdate = new Date();
      curl.get("https://lastbottlewines.com")
        .then(({ statusCode, body, headers }) => {
          if (statusCode != 200) {
            logError(err);
            return;
          }

          // parse the body and look for the offer-name class
          const root = parser.parse(body);
          // TODO: catch parse errors
          const offerName = root.querySelector(".offer-name");
          if (!offerName) {
            logError("offer-name class not found, perhaps the page formatting has changed");
            return;
          }

          // TODO: write hash to a local FS to tell when page has changed?
          const hash = crypto.createHash('md5').update(body).digest("hex");
          if (!reportNothing && hash == this.savedSettings.lastMD5) {
            console.log("No changes since last update");
            if (this.savedSettings.lastMD5Update != null) {
              console.log("Time since last change: " + ((new Date()) - savedSettings.lastMD5Update));
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

          for (name in this.savedSettings.matching) {
            if (body.match(new RegExp("\\b" + this.savedSettings.matching[name] + "\\b", "i"))) {
              this.sendMessage("Found a match for " + this.savedSettings.matching[name] + " in " + offerName.rawText + "\nhttps://lastbottlewines.com")
                .then(function (data) {
                  console.log("We got some data");
                  console.log(data);
                })
                .catch(function (err) {
                  logError(err);
                });
              return;
            }
          }
          if (!!reportNothing)
            this.sendMessage("No matching terms in '" + offerName.rawText + "'");
          console.log("No matching terms for '" + offerName.rawText + "'");
        })
        .catch((e) => {
          console.log(e);
        });
      };
};

exports.watchRuntime = watchRuntime;
