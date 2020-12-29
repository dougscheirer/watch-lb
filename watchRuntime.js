require('dotenv').config();
const curl = require('curl-request');
const parser = require('node-html-parser');
const crypto = require('crypto');
const mjs = require('moment');
const redis = require("redis");
const { promisify } = require('util');
const durationParser = require('parse-duration');
const fs = require('fs');
const url = require('url');
const { openStdin } = require('process');

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
const siteLogin = siteroot + "login";
const siteLoginHtml = siteroot + "login.html";

function watchRuntime(telegramApi, redisApi, chatid, auth) {
  if (!telegramApi)
    throw new Error("telegramApi is required");
  if (!redisApi)
     throw new Error("redis client is required");
  if (!chatid) 
    chatid = process.env.CHAT_ID;
  
  this.telegramApi = telegramApi,
    this.client = redisApi,
    this.chatid = chatid,
    this.auth = auth,
    this.getAsync = promisify(this.client.get).bind(this.client),
    this.logger = console.log,

    this.runtimeSettings = {
      intervalTimer: null,
      startTime: new Date()
    },

    this.savedSettings = {
      lastMD5: null,
      lastMD5Update: null,
      lastOfferID: null,
      lastMessage: null,
      lastIntervalUpdate: null,
      lastMatch: null,
      sent24hrMessage: false,
      matching: matching_default.slice(),
      defaultRate: null,
      pauseUntil: -1,
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
        msgResp += "Last offer ID: " + this.savedSettings.lastOfferID + "\n";
      }
      msgResp += "Current interval: " + mjs.duration(this.savedSettings.defaultRate * 1000 * 60).humanize() + "\n";
      msgResp += "Service uptime: " + mjs.duration(new Date() - this.runtimeSettings.startTime).humanize();
      try {
        if (this.savedSettings.pauseUntil != -1) {
         msgResp += "\nPaused until " + ((this.savedSettings.pauseUntil > 0) ? this.savedSettings.pauseUntil : "forever");
       }
      } catch (e) {
        this.logger(e);
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

    this.parseCookies = (setCookies, existing) => {
      // strip the first cookie value, the rest is "interesting" but not really needed for this
      // also split the key from the value so that we can merge them later
      var cookies = existing || {};
      for (var i in setCookies) {
        const split = setCookies[i].split(';')[0];
        const key = split.split('='); 
        cookies[key[0]] = split;
      }
      return cookies;
    },

    this.joinCookies = (cookies) => {
      if (cookies == null) {
        return null;
      }
      var cookieString = "Cookie: ";
      var cookieArray = [];
      for (var key in cookies) {
        cookieArray.push(cookies[key]);
      }
      return cookieString + cookieArray.join('; ');
    },

    this.login = async () => {
      // 1. get request on /login.html
      return this.fetchUrl(siteLogin)
        .then(({ statusCode, body, headers }) => {
         
          if (statusCode != 200) {
            this.logError("Fetch error for /login: " + statusCode);
            return { error: "Fetch error for /login: " + statusCode };
          }

          // get the set-cookies for the POST request
          var cookies = this.parseCookies(headers['set-cookie']);
          // now POST with the cookies and our auth data as the body
          var auth = this.auth;

          return this.postUrl(siteLoginHtml, [ this.joinCookies(cookies), 'Content-Type: application/x-www-form-urlencoded' ], auth)
        }).then(({ statusCode, body, headers }) => {
            // check for a 302 redirect to /
            if (statusCode != 302 || headers['location'] != '/') {
              // failed!
              return { error: "Bad status code or location from post: " + statusCode + " location: " + headers['location']};
            }

            // use the new cookies
            cookies = this.parseCookies(headers['set-cookie'], cookies);

            // grab the /
            return this.fetchUrl(siteroot, [ this.joinCookies(cookies) ])
        }).then(({ statusCode, body, headers }) => {
            if (statusCode != 200) {
              return { error: "Bad status code from redirect: " + statusCode };
            }
            // verify root now has the .account-link
            const root = parser.parse(body);
            const account = root.querySelector(".account-links").querySelector(".account-link");

            if (account == null) {
              return { error: "No account link in page, not authenticated" };
            }

            return { cookies: this.parseCookies(headers['set-cookie'], cookies), body: body };
          });
    },

    this.handleLogin = async (msg) => {
      return this.login().then( (authState) => {
        if (authState == null || authState.error != null) {
          this.sendMessage("Failed to authenticate: " + authState.error);
        } else {
          this.sendMessage("Authentication successful");
        }
      });
    },

    this.validateOffer = (authState, count) => {
      if (authState == null || authState.error != null) {
        this.sendMessage("Failed to authenticate: " + authState.error);
        return;
      }

      // 2. make sure it's still available, i.e. the previous offer is identical to the current one
      const offerData = this.parseOffer(authState.body);
      if (offerData.id != this.savedSettings.lastOfferID) {
        return Promise.reject("Offer has changed (prev/cur): " + this.savedSettings.lastOfferID + " / " + offerData.id);
      }

      return offerData;
    },

    this.addToCart = async (authState, count, offerData) => {
        return this.fetchUrl(siteroot + "cart/update_quantity/" + offerData.id + "/" + count + "/", authState.cookies)
    },

    this.validateCartResponse = (statusCode, body, offerData, count) => {
      // validate the JSON response: 
      // {"quantity":(count)),"subtotal":(price*count),"shipping":0,"tax":(\d+.\d+),"discount":(\d+),"credits":(\d+),"total":(\d+.\d+)}
      var resp = JSON.parse(body);
      if (statusCode != 200 || resp.error != null)  {
        return { error: "Bad response from cart (" + statusCode + ") :" + resp.error };
      }
      // price matches what we expected
      if (resp.subtotal != offerData.price * count) { 
        return { error: "Unexpected subtotal: got " + resp.subtotal + " but expected " + offerData * count};
      }
      // hard code a spending limit
      if (resp.subtotal > 200) {
        return { error: "Exceeded max spending limit: " + resp.subtotal};
      }

      return resp;
    },

    this.handleBuy = async (msg, match) => {
      var count = 0;
      if (match.length == 2) {
        count = parseInt(match[1]);
      }

      if (count <= 0) {
        this.sendMessage("/buy N, count is required");
        return;
      }

      var auth, offerData;

      // 1. login
      return this.login().then((authState) => {
        auth = authState
        offerData = this.validateOffer(authState, count);
        return this.addToCart(authState, count, offerData);
      }).then( (statusCode, body, headers ) => {
        var resp = this.validateCartResponse(statusCode, body, offerData, count);
        if (resp.error) {
          return Promise.reject(resp.error);
        }
        if (resp.shipping != 0) {
          // try to turn off insurance first
          return this.setNoInsurance(authState, offerData)
            .then((statusCode, body, headers) => {
              // revalidate
              resp = this.validateCartResponse(statusCode, body, offerData, count);
              if (resp.error) {
                return Promise.reject(resp.error);
              }
              if (resp.shipping != 0) {
                return Promise.reject("Non-zero shipping costs: " + resp.shipping)
              }
              // now checkout
              return this.checkOut(authState, offerData);
            });
        }

        return this.checkOut(authState, offerData);
      }).then( (statusCode, body, headers) => {
        // do checkout stuff
      }).catch((e) => {
        // something went wrong
        this.sendMessage(e);
      })
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

    // allow for fetchUrl and postUrl to be overridden in test mode
    this.fetchUrl = (url, headers) => {
      var fetch = new curl();
      if (headers) {
        fetch.setHeaders(headers);
      }
      return fetch.get(url);
    },

    this.postUrl = (url, headers, data) => {
      var post = new curl();
      if (headers) {
        post.setHeaders(headers);
      }
      if (data) {
        post.setBody(data);
      }
      return post.post(url);
    },

    this.parseOfferLink = (text) => {
      if (!text) {
        return null;
      }
      // the offer id is the last part of the link minus the .html
      const parsed = url.parse(text);
      const split = parsed.pathname.split('/');
      return split[split.length-1].split('.')[0];
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

      this.fetchUrl("https://www.lastbottlewines.com")
        .then(({ statusCode, body, headers }) => {
          if (statusCode != 200) {
            this.logError("Fetch error: " + statusCode);
            return;
          }

          // parse the body and look for the offer-name class
          // catch parse errors?  I think those just end up as roots with no data
          const offerData = this.parseOffer(body);

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
          this.saveSettings();

          for (var name in this.savedSettings.matching) {
            if (body.match(new RegExp("\\b" + this.savedSettings.matching[name] + "\\b", "i"))) {
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
    },

    this.logStartTime = () => {
      this.runtimeSettings.startTime = new Date();
      this.saveSettings();
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
  // buy count
  telegramApi.onText(/\/buy$/, this.handleBuy);
  telegramApi.onText(/\/buy (.+)/, this.handleBuy);
  // login check
  telegramApi.onText(/\/login$/, this.handleLogin);
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
      "/buy (count)\n" +
      "/login\n" +
      "/help");
  });
  // /settings
  telegramApi.onText(/\/settings$/, this.handleSettings);
  telegramApi.onText(/\/*/, () => {
    this.sendMessage("Unknown command");
  })
}

exports.watchRuntime = watchRuntime;
