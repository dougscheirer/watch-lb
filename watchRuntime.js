require('dotenv').config();
const parser = require('node-html-parser');
const crypto = require('crypto');
const mjs = require('moment');
const redis = require("redis");
const { promisify } = require('util');
const durationParser = require('parse-duration');
const fs = require('fs');
const url = require('url');
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

  // allow for fetchUrl and postUrl to be overridden in test mode
  // I could mock lib that too, but axios/jest mock had some hiccups
  this.fetchUrl = async (url) => {
    return axios.get(url);
  };

  this.logCmd = (cmd) => {
    if (!cmd.text) {
      this.logger("Undefined cnd.text");
      this.logger(cmd);
    }
    this.logger("Command: " + cmd.text);
  }

  var filledOpts = {};
  if (!options.telegramApi)
    throw new Error("telegramApi is required");
  if (!options.redisApi)
     throw new Error("redis client is required");
  filledOpts.telegramApi = options.telegramApi;
  filledOpts.redisApi = options.redisApi;
  filledOpts.chatid = options.chatid | process.env.CHAT_ID;
  filledOpts.logger = options.logger ? options.logger : formattedLog;
  filledOpts.errorLogger = options.errorLogger ? options.errorLogger : formattedLog;
  filledOpts.setInterval = options.setInterval ? options.setInterval : setInterval;
  filledOpts.clearInterval = options.clearInterval ? options.clearInterval : clearInterval;
  filledOpts.fetchFunc = options.fetchFunc ? options.fetchFunc : this.fetchUrl;

  this.telegramApi = filledOpts.telegramApi,
    this.client = filledOpts.redisApi,
    this.chatid = filledOpts.chatid,
    this.getAsync = promisify(this.client.get).bind(this.client),
    this.setAsync = promisify(this.client.set).bind(this.client),
    this.keysAsync = promisify(this.client.keys).bind(this.client),
    this.logger = filledOpts.logger,
    this.errorLogger = filledOpts.errorLogger,
    this.fetchUrlFunc = filledOpts.fetchFunc,
    this.runtimeSettings = {
      intervalTimer: -1,
      startTime: new Date(),
    },
    this.setInterval = filledOpts.setInterval,
    this.clearInterval = filledOpts.clearInterval,

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

    this.saveSettings = async (opts) => {
      this.savedSettings = { ...this.savedSettings, ...opts };
      return this.setAsync('watch-lb-settings', JSON.stringify(this.savedSettings));
    },

    this.sendList = () => {
      this.sendMessage("Current search terms:\n" + this.savedSettings.matching.join("\n"));
    },

    this.handleStart = async (msg) => {
      this.logCmd(msg);
      const chatId = msg.chat.id;

      this.sendMessage("Your chat id is " + chatId);
    },

    // /list
    this.handleList = async (msg) => {
      this.logCmd(msg);
      this.sendList();
    },

    // /list default
    this.handleListDefault = async (msg) => {
      this.logCmd(msg);
      await this.saveSettings({ matching: matching_default.slice() });
      this.logger("Restored default list");
      this.sendList();
    },

    // /status
    this.handleStatus = async (msg) => {
      this.logCmd(msg);
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
    this.handleAdd = async (msg, match) => {
      this.logCmd(msg);
      const toAdd = match[1].toLowerCase();
      if (this.savedSettings.matching.indexOf(toAdd) >= 0) {
        this.sendMessage(toAdd + " is already a search term");
        return;
      }
      this.savedSettings.matching.push(toAdd);
      this.sendList();
      // invalidate the MD5 cache
      await this.saveSettings({
        lastMD5: null,
        lastMD5Update: null,
        lastOfferID: null,
        lastOfferName: "",
        lastOfferPrice: 0
      });
      return this.checkWines(true);
    },

    // /del (term)
    this.handleDelete = async (msg, match) => {
      this.logCmd(msg);
      const toDel = match[1].toLowerCase();
      if (this.savedSettings.matching.indexOf(toDel) < 0) {
        this.sendMessage(toDel + " is not a search term");
        return;
      }
      await this.saveSettings({ matching: this.savedSettings.matching.splice(toDel, 1) });
      this.sendList();
      // write to redis
      await this.saveSettings({
      // invalidate the MD5 cache
        lastMD5: null,
        lastMD5Update: null,
        lastOfferID: null,
        lastOfferName: "",
        lastOfferPrice: 0
      });
      return this.checkWines(true);
    },

    // /now
    this.handleNow = async (msg) => {
      this.logCmd(msg);
      return this.checkWines(true);
    },

    // /uptick (human-readable time | default)"
    this.handleUptick = async (msg, match) => {
      this.logCmd(msg);
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
      this.clearInterval(this.runtimeSettings.intervalTimer);
      await this.checkWines();
      this.runtimeSettings.intervalTimer = this.setInterval(this.checkWines, number * 1000 * 60);

      // save the last setting
      await this.saveSettings({ defaultRate: number });
      this.sendMessage("Check interval changed to " + mjs.duration(number * 1000 * 60).humanize());
    },

    this.handlePause = async (msg, match) => {
      this.logCmd(msg);
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
      await this.saveSettings({ pauseUntil: until });
      this.sendMessage("Pausing until " + ((until > 0) ? until : "forever"));
    },

    this.handleResume = async (msg) => {
      this.logCmd(msg);
      await this.saveSettings({ pauseUntil: -1 });
      this.sendMessage("Resuming with check interval of " + mjs.duration(this.savedSettings.defaultRate * 1000 * 60).humanize());
    },

    this.handleSettings = async (msg) => {
      this.logCmd(msg);
      this.sendMessage(JSON.stringify(this.savedSettings));
    },

    this.handleRecentOffers = async (msg, match) => {
      this.logCmd(msg);
      // recent 10 or more?
      var retCount = 10;
      if (match.length == 2) {
        retCount = parseInt(match[1]);
      }

      if (isNaN(retCount)) {
        this.sendMessage(match[1] + " is not a valid number.  Specify a number of offers to fetch");
        return;
      }
      // fetch all keys, then sort 
      const rows = await this.keysAsync('offer-match*');
      if (rows.length == 0) {
        return this.sendMessage("No recent offer matches found");
      }
      const retRows = rows.sort().slice(-1*retCount);
      var message = 'Fetched ' + retRows.length + ' offers\n';
      for (i in retRows) {
        const val = await this.getAsync(retRows[i]);
        message += retRows[i] + ": " + JSON.stringify(JSON.parse(val), null, 2) + "\n";
      }
      return this.sendMessage(message);
    },

    this.handleListErrors = async (msg, match) => {
      this.logCmd(msg);
      const rows = await this.keysAsync('offer-invalid*');
      if (rows.length == 0) {
        return this.sendMessage("No errors found");
      }
      return this.sendMessage(rows.join("\n"));
    },

    this.handleClearError = async (msg, match) => {
      this.logCmd(msg);
      if (match.length == 1) {
        const rows = await this.keysAsync('offer-invalid*');
        for (var i = 0, j = rows.length; i < j; ++i) {
          await this.client.del(rows[i]);
        }
        return this.sendMessage("Cleared all offer invalid keys")
      }
      // just the requested one
      await this.client.del(match[1]);
      return this.sendMessage("Cleared " + match[1]);
    },

    this.handleShowError = async (msg, match) => {
      this.logCmd(msg);
      if (match.length != 2) {
        return this.sendMessage("/showerror requires an error key");
      }
      // fetch the key
      const error = await this.getAsync(match[1]);
      if (!error) {
        return this.sendMessage('No error key value ' + match[1]);
      }
      return this.sendMessage('Error ' + match[1] + "\n" + error);
    },

    this.logError = async (message) => {
      this.logger("ERROR >>>");
      this.logger(message);
      this.sendMessage(message);
    },

    this.sendMessage = async (message, isHTML) => {
      this.logger("Sending message to " + this.chatid + " : " + message);
      if (message.length > 4096) {
        // elipseize messages that are too long
        message = message.substring(0, 4093) + '...';
      }
      return this.telegramApi.sendMessage(this.chatid, message, 
              (isHTML ? { parse_mode: 'HTML' } : {}));
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
      const rawText = (text) => { return (text && text.rawText ? text.rawText : null ); }
      return { name: rawText(offerName), 
        price: rawText(offerPrice), 
        link: offerLink, 
        id: this.parseOfferLink(offerLink), 
        md5: md5
      };
    },

    toRedisDatestamp = (dt) => {
        function pad2(n) {  // always returns a string
          return (n < 10 ? '0' : '') + n;
      }

      return dt.getFullYear() +
          pad2(dt.getMonth() + 1) + 
          pad2(dt.getDate()) +
          pad2(dt.getHours()) +
          pad2(dt.getMinutes()) +
          pad2(dt.getSeconds());
    },

    this.writeOffer = async (offerData) => {
      const key = 'offer-match-' + toRedisDatestamp(new Date(Date.now()));
      return this.setAsync(key, JSON.stringify(offerData));
    }

    this.checkWines = async (verbose) => {
      this.savedSettings.lastIntervalUpdate = new Date();
      if (this.savedSettings.pauseUntil == 0) {
        if (verbose) {
          this.sendMessage("Paused, use /resume to restart");
        }
        return; // we're paused
      } else if (this.savedSettings.pauseUntil != -1) {
        if (this.savedSettings.lastIntervalUpdate > this.savedSettings.pauseUntil) {
          await this.saveSettings({ pauseUntil: -1 });
        } else {
          if (verbose) {
            this.sendMessage("Paused, will resume on " + this.savedSettings.pauseUntil);
          }
          return; // we're paused
        }
      }
      
      await this.fetchUrlFunc("https://www.lastbottlewines.com")
        .then(async (res) => {
          if (res.status != 200) {
            this.logError("Fetch error: " + res.status);
            return;
          }

          // parse the body and look for the offer-name class
          // catch parse errors?  I think those just end up as roots with no data
          const offerData = this.parseOffer(res.data);
          this.logger("Offer: " + JSON.stringify(offerData));

          if (!offerData.name) {
            const redisRecord = 'offer-invalid-' + toRedisDatestamp(new Date(Date.now()));
            this.logError("offer-name class not found, perhaps the page formatting has changed or there was a page load error: " + redisRecord);
            // save the fetched data to redis for later analysis
            return this.setAsync(redisRecord, res.data);
          }

          // non-verbose just logs and forgets
          if (!verbose && offerData.md5 == this.savedSettings.lastMD5) {
            this.logger("No changes since last update");
            if (this.savedSettings.lastMD5Update != null) {
              this.logger("Time since last change: " + ((new Date()) - this.savedSettings.lastMD5Update));
              // how long since it changed?  are we not getting updates?
              if (!this.savedSettings.sent24hrMessage && ((new Date()) - this.savedSettings.lastMD5Update) > 24 * 60 * 60 * 1000) {
                await this.saveSettings({ sent24hrMessage: true });
                this.sendMessage("No updates for more than 24h");
              }
            }
            return;
          }

          // cache this for later when we decide on notification
          const lastOfferID = this.savedSettings.lastOfferID;

          // remember the MD5 and if we have sent our message
          await this.saveSettings({ 
            sent24hrMessage: false,
            lastMD5: offerData.md5,
            lastMD5Update: new Date(),
            lastOfferID: offerData.id,
            lastOfferName: offerData.name,
            lastOfferPrice: offerData.price,
          });

          // just match on the first one, then stop
          var match = null;
          for (var name in this.savedSettings.matching) {
            if (res.data.match(new RegExp("\\b" + this.savedSettings.matching[name] + "\\b", "i"))) {
              match = name;
              break;
            }
          }

          if (match != null) {
            const that = this;
            // did we already notified on this one
            if (!verbose && this.savedSettings.lastMatch == offerData.name) {
              // log and return
              this.logger("Identical offer id on new match, skipping.")
              return;
            }

            // remember the offer name for verification check on /buy
            await this.saveSettings({ lastMatch: offerData.name });
            // format the message and compare to the last one, if they are identical just skip it
            const msg = "Found a match for " + this.savedSettings.matching[match] + " ($" + offerData.price + ") in " 
                        + '<a href="' + offerData.link + '">' + offerData.name + "</a>";

            // verbose means always report
            if (verbose || msg != this.savedSettings.lastMessage) {
              this.sendMessage(msg, true)
                .then(async function (data) {
                  that.saveSettings({ lastMessage: msg });
                  that.logger(data);
                  // write this offer to storage
                  await that.writeOffer(offerData);
                })
                .catch(function (err) {
                  that.logError(err);
                });
                return;
            }
          }

          if (verbose) {
            this.sendMessage("No matching terms in '" + offerData.name + "'");
          }
        })
        .catch((e) => {
          this.logError(e);
        });
    },

    /* jshint expr: true */
    this.loadSettings = async () => {
      this.logger("loadSettings");
      
      return this.getAsync('watch-lb-settings').then(async (res) => {
        this.logger("Inside getAsync.then");
        if (!res) {
          // initialize matching
          this.logger("Initializing from defaults");
          await this.saveSettings();
        } else {
          this.logger("Loading saved settings");
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
          await this.saveSettings({ defaultRate: process.env.CHECK_RATE || DEFAULT_RATE });
        }
        if (this.runtimeSettings.intervalTimer > 0) {
          this.clearInterval(this.runtimeSettings.intervalTimer);
        }
        this.logger("setting the interval");
        this.runtimeSettings.intervalTimer = this.setInterval(this.checkWines, 1000 * 60 * this.savedSettings.defaultRate);
      });
    },

    // shutdown
    this.stop = () => {
      this.sendMessage("Watcher is shutting down");
      this.clearInterval(this.runtimeSettings.intervalTimer);
      this.runtimeSettings.intervalTimer = -1;
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
  // errors
  this.telegramApi.onText(/\/lserror/, this.handleListErrors);
  this.telegramApi.onText(/\/showerror (.+)/, this.handleShowError);
  this.telegramApi.onText(/\/showerror/, this.handleShowError);
  this.telegramApi.onText(/\/clrerror$/, this.handleClearError);
  this.telegramApi.onText(/\/clrerror (.+)/, this.handleClearError);
  // recent
  this.telegramApi.onText(/\/recent$/, this.handleRecentOffers);
  this.telegramApi.onText(/\/recent (.+)/, this.handleRecentOffers);
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
      "/lserror\n" +
      "/showerror (key)\n" +
      "/clrerror [key]\n" + 
      "/recent [count]\n" + 
      "/help");
  });
  // /settings
  this.telegramApi.onText(/\/settings$/, this.handleSettings);
  this.telegramApi.onText(/\/*/, (msg, match) => {
    this.logCmd(msg);
    this.sendMessage("Unknown command");
  })
}

exports.watchRuntime = watchRuntime;
