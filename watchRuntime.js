require('dotenv').config();
const curl = require('axios');
const parser = require('node-html-parser');
const crypto = require('crypto');
const mjs = require('moment');
const redis = require("redis");
const { promisify } = require('util');
const durationParser = require('parse-duration');
const fs = require('fs');
const url = require('url');
const { openStdin } = require('process');
const { isDuration } = require('moment');
const axios = require('axios');

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

const siteroot = "https://www.lastbottlewines.com/";

function watchRuntime(options) {
  function formattedLog(message) {
    // formatted console output
    let out = message;
    if (typeof(out) == 'object') {
      out = JSON.stringify(out, null, 2);
    }
    console.log(mjs().format() + ": " + out);
  }

  if (!options.telegramApi)
    throw new Error("telegramApi is required");
  if (!options.redisApi)
     throw new Error("redis client is required");
  if (!options.chatid) 
    options.chatid = process.env.CHAT_ID;
  if (!options.logger) 
    options.logger = formattedLog;
  if (!options.errorLogger) 
    options.errorLogger = formattedLog;
    
  // allow for fetchUrl and postUrl to be overridden in test mode
  // I could mock lib that too, but axios/jest mock had some hiccups
  this.fetchUrl = (url) => {
    return axios.get(url);
  };
  
  this.telegramApi = options.telegramApi,
    this.client = options.redisApi,
    this.chatid = options.chatid,
    this.getAsync = promisify(this.client.get).bind(this.client),
    this.logger = options.logger,
    this.errorLogger = options.errorLogger,
    this.fetchUrlFunc = (options.fetchFunc) ? options.fetchFunc : this.fetchUrl;
    this.runtimeSettings = {
      intervalTimer: null,
      startTime: new Date()
    },

    // Note: Date and other non-string objects must be converted from strings in loadSettings()
    this.savedSettings = {
      lastMD5: null,
      lastMD5Update: null,  // Date
      lastOfferID: null,
      lastOfferName : "",
      lastOfferPrice: 0,
      lastMessage: null,
      lastIntervalUpdate: null, // Date
      lastMatch: null,
      sent24hrMessage: false,
      matching: matching_default.slice(),
      defaultRate: null,
      pauseUntil: -1, // -1 is not paused, 0 is forever, other is a Date
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
        msgResp += "Last offer: (" + this.savedSettings.lastOfferID + ") " + this.savedSettings.lastOfferName + " $" + this.savedSettings.lastOfferPrice + "\n";
        msgResp += "Last MD5: " + this.savedSettings.lastMD5 + "\n";
      }
      msgResp += "Current interval: " + mjs.duration(this.savedSettings.defaultRate * 1000 * 60).humanize() + "\n";
      msgResp += "Service uptime: " + mjs.duration(new Date() - this.runtimeSettings.startTime).humanize();
      try {
        if (this.savedSettings.pauseUntil != -1) {
         msgResp += "\nPaused until " + ((this.savedSettings.pauseUntil == 0) ? "forever" : this.savedSettings.pauseUntil);
       }
      } catch (e) {
        this.logError(e);
      }
      try {
        const contents = fs.readFileSync('./git-head.txt', 'utf8');
        msgResp += "\ngit: \n" + contents;
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
      this.savedSettings.lastOfferID = null;
      this.savedSettings.lastOfferName = "";
      this.savedSettings.lastOfferPrice = 0;
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
      this.savedSettings.lastOfferID = null;
      this.savedSettings.lastOfferName = "";
      this.savedSettings.lastOfferPrice = 0;
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
      var duration = null;
      var datestamp = null;
      var timestamp = null;
      var until = null;
      if (match.length == 1) {
        // just pause, no end time
        until = 0;
      } else {
        // try to parse duration
        // if only numbers, then assume it's in minutes
        const reg = /^\d+$/;
        if (reg.test(match[1])) {
          duration = parseInt(match[1]) * 60 * 1000;
        } else {
          // try to parse a duration string (comes out in ms) and convert to minutes
          duration = durationParser(match[1]);
          // try to parse datestamp (12/1/2020)
          datestamp = new Date(match[1]);
          // try to parse timestamp (12:00)
          timestamp = mjs(match[1],"HH:mm");
        }
        // write the until time as 0 (forever) or a datestamp
        if (duration > 0) {
          until = new Date((new Date()).getTime() + duration);
        } else if (datestamp != null && !isNaN(datestamp.valueOf())) {
          until = new Date(datestamp);
        } else if (timestamp != null && timestamp.isValid()) {
          until = new Date(timestamp);
        } else {
          // garbage in, fail
          this.sendMessage("Unrecognized pause argument");
          return;
        }
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
      return this.telegramApi.sendMessage(this.chatid, message);
    },

    this.parseOfferLink = (text) => {
      if (!text) {
        return null;
      }
      // the offer id is the last part of the link minus the .html
      const parsed = url.parse(text);
      const split = parsed.pathname.split('/');
      return (split[split.length-1] == '') ? 
        split[split.length-2] : 
        split[split.length-1].split('.')[0];
    },

    this.parseOffer = (body) => {
      const root = parser.parse(body);

      const offerName = root.querySelector(".offer-name");
      const offerPrice= root.querySelector(".amount.lb");
      var offerLink = null;
      const purchase = root.querySelector(".purchase-it");
      if (purchase) {
        const offer = purchase.querySelector("a");
        offerLink = offer ? offer.getAttribute('href') : null;
      }
      const md5 = crypto.createHash('md5').update(body).digest("hex");
      const rawText = (text) => { return (text && text.rawText ? text.rawText : null );}
      return { name: offerName.rawText, 
        price: rawText(offerPrice), 
        link: offerLink, 
        id: this.parseOfferLink(offerLink), 
        md5: md5
      };
    },

    this.checkWines = async (reportNothing) => {
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
      
      await this.fetchUrlFunc("https://www.lastbottlewines.com")
        .then((res) => {
          if (res.statusCode != 200) {
            this.logError("Fetch error: " + res.statusCode);
            return;
          }

          // parse the body and look for the offer-name class
          // catch parse errors?  I think those just end up as roots with no data
          const offerData = this.parseOffer(res.data);

          if (!offerData.name) {
            this.logError("offer-name class not found, perhaps the page formatting has changed or there was a page load error");
            return;
          }

          // write hash to a local FS to tell when page has changed?
          // TODO: compare the offerID instead?
          if (!reportNothing && offerData.md5 == this.savedSettings.lastMD5) {
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
          this.savedSettings.lastMD5 = offerData.md5;
          this.savedSettings.lastMD5Update = new Date();
          this.savedSettings.lastOfferID = offerData.id;
          this.savedSettings.lastOfferName = offerData.name;
          this.savedSettings.lastOfferPrice = offerData.price;
    
          this.saveSettings();

          for (var name in this.savedSettings.matching) {
            if (res.data.match(new RegExp("\\b" + this.savedSettings.matching[name] + "\\b", "i"))) {
              const that = this;
              // remember the offer name for verification check on /buy
              this.savedSettings.lastMatch = offerData.name;
              this.saveSettings();
              // format the message and compare to the last one, if they are identical just skip it
              const msg = "Found a match for " + this.savedSettings.matching[name] + " ($" + offerData.price + ") in " + offerData.name + "\nhttps://lastbottlewines.com";
              if (msg != this.savedSettings.lastMessage) {
                this.sendMessage(msg)
                  .then(function (data) {
                    that.savedSettings.lastMessage = msg;
                    that.saveSettings();
                    that.logger("We got some data");
                    that.logger(data);
                  })
                  .catch(function (err) {
                    that.logError(err);
                  });
                return;
              }
            }
          }
          if (!!reportNothing)
            this.sendMessage("No matching terms in '" + offerData.name + "'");
            this.logger("No matching terms for '" + offerData.name + "'");
        })
        .catch((e) => {
          this.logError(e);
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
          this.savedSettings.pauseUntil = (this.savedSettings.pauseUntil == -1) ? -1 : this.savedSettings.pauseUntil == 0 ? 0 : new Date(this.savedSettings.pauseUntil);
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
    },

    this.logStartTime = () => {
      this.runtimeSettings.startTime = new Date();
      this.saveSettings();
    },

    // shutdown
    this.stop = () => {
      this.sendMessage("Watcher is shutting down");
      clearInterval(this.runtimeSettings.intervalTimer);
    };


  
  // load up all of the text processors
  // /start
  this.telegramApi.onText(/\/start$/, this.handleStart);
  // /list
  this.telegramApi.onText(/\/list$/, this.handleList);
  // /list default
  this.telegramApi.onText(/\/list default$/, this.handleListDefault);
  // /status
  this.telegramApi.onText(/\/status$/, this.handleStatus);
  // /add (term)
  this.telegramApi.onText(/\/add (.+)/, this.handleAdd);
  // /del (term)
  this.telegramApi.onText(/\/del (.+)/, this.handleDelete);
  // /now
  this.telegramApi.onText(/\/now$/, this.handleNow);
  // /uptick (human-readable time | default)"
  this.telegramApi.onText(/\/uptick (.+)/, this.handleUptick);
  // /pause [human-readable time]
  this.telegramApi.onText(/\/pause$/, this.handlePause);
  this.telegramApi.onText(/\/pause (.+)/, this.handlePause);
  // /resume
  this.telegramApi.onText(/\/resume$/, this.handleResume);
  // /help
  this.telegramApi.onText(/\/help$/, () => {
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
  this.telegramApi.onText(/\/settings$/, this.handleSettings);
  this.telegramApi.onText(/\/*/, () => {
    this.sendMessage("Unknown command");
  })
}

exports.watchRuntime = watchRuntime;
