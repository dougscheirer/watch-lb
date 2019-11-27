// .env reader
require('dotenv').config()
const curl = new (require( 'curl-request' ))();
const parser = require('node-html-parser');
const telegram = require('node-telegram-bot-api');
const crypto = require('crypto');
const os = require('os');
const mjs = require('moment');
const redis = require("redis");
const {promisify} = require('util');

// determine redis host from environment and connect
const opts = { host: process.env.REDIS_HOST || "localhost", port: process.env.REDIS_PORT || 6379 };
const client = redis.createClient(opts);
const getAsync = promisify(client.get).bind(client);

// connect to telegram
const api = (process.env.NO_TELEGRAM != 1) ? new telegram(process.env.API_TOKEN, {polling: true} ) : null;

var runtimeSettings = {
    intervalTimer: null,
}

var currentDefault = null;

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

var savedSettings = {
  lastMD5: null,
  lastMD5Update: null,
  lastIntervalUpdate: null,
  sent24hrMessage: false,
  matching: matching_default,
  defaultRate: null
}

function saveSettings() {
    client.set('watch-lb-settings', JSON.stringify(savedSettings));
}

function sendList() {
    sendMessage("Current search terms:\n" + savedSettings.matching.join("\n"));
}

if (api) {
    // /start
    api.onText(/\/start$/, (msg) => {
        const chatId = msg.chat.id;
    
        sendMessage("Your chat id is " + chatId);
    });

    // /list
    api.onText(/\/list$/, (msg) => {
        sendList();
    });

    // /list default
    api.onText(/\/list default$/, (msg) => {
        savedSettings.matching = matching_default;
        saveSettings();
        console.log("Restored default list");
        sendList();
    });
    
    // /status
    api.onText(/\/status$/, (msg) => {
        const duration = mjs.duration(savedSettings.lastIntervalUpdate - savedSettings.lastMD5Update);
        if (savedSettings.lastMD5Update == null) {
            sendMessage("Never checked");
            return;
        }
        sendMessage("Last check at " + savedSettings.lastIntervalUpdate + "\nLast difference at " + savedSettings.lastMD5Update + " (" + duration.humanize() + ")");
        console.log(msg);
        console.log(msg.chat);
    });

    // /add (term)
    api.onText(/\/add (.+)/, (msg, match) => {
        const toAdd = match[1].toLowerCase();
        if (savedSettings.matching.indexOf(toAdd) >= 0 ) {
            sendMessage(toAdd + " is already a search term");
            return;
        }
        savedSettings.matching.push(toAdd);
        sendList();
        // invalidate the MD5 cache
        savedSettings.lastMD5 = null;
        savedSettings.lastMD5Update = null;
        // write to redis
        saveSettings();
        checkWines(true);
    });

    // /del (term)
    api.onText(/\/del (.+)/, (msg, match) => {
        const toDel = match[1].toLowerCase();
        if (savedSettings.matching.indexOf(toDel) < 0 ) {
            sendMessage(toDel + " is not a search term");
            return;
        }
        savedSettings.matching.splice(toDel, 1);
        sendList();
        // write to redis
        saveSettings();
        // invalidate the MD5 cache
        savedSettings.lastMD5 = null;
        savedSettings.lastMD5Update = null;
        // write to redis
        saveSettings();
        checkWines(true);
    });
    
    // /now
    api.onText(/\/now$/, (msg) => {
        checkWines(true);
    });

    // /uptick (time | default)"
    api.onText(/\/uptick (.+)/, (msg, match) => {
        var number = null;
        if (match[1] == "default") {
            number = savedSettings.defaultRate;
        } else {
            number = parseInt(match[1]);
        }

        if (!number) {
            sendMessage(match[1] + " is not a valid number.  Specify a number of minutes to change the check interval");
            return;
        }
    
        // change the frequency of checks to (match) minutes
        clearInterval(runtimeSettings.intervalTimer);
        checkWines();
        runtimeSettings.intervalTimer = setInterval(checkWines, number*1000*60);
        // save the last setting
        savedSettings.defaultRate = number;
        saveSettings();
        sendMessage("Check interval changed to " + number + " minutes");
    });
}

function logError(message) {
    console.log("ERROR >>>");   
    console.log(message);
    sendMessage(message);
}

function sendMessage(message) {
    console.log("Sending message: " + message);
    return (api) ? api.sendMessage(process.env.CHAT_ID, message) : console.log("No API, just logging");
}

function checkWines(reportNothing) {
    savedSettings.lastIntervalUpdate = new Date();
    curl.get("https://lastbottlewines.com")
    .then(({statusCode, body, headers}) => {
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
        const hash=crypto.createHash('md5').update(body).digest("hex");
        if (!reportNothing && hash == savedSettings.lastMD5) {
            console.log("No changes since last update");
            if (savedSettings.lastMD5Update != null) {
                console.log("Time since last change: " + ((new Date()) - savedSettings.lastMD5Update));
                // how long since it changed?  are we not getting updates?
                if (!savedSettings.sent24hrMessage && ((new Date()) - savedSettings.lastMD5Update) > 24*60*60*1000) {
                    savedSettings.sent24hrMessage = true;
                    sendMessage("No updates for more than 24h");
                    saveSettings();
                }
            }
            return;
        }

        // remember the MD5 and if we have sent our message
        savedSettings.sent24hrMessage=false;
        savedSettings.lastMD5=hash;
        savedSettings.lastMD5Update=new Date();
        saveSettings();

        for (name in savedSettings.matching) {
            if (body.match(new RegExp("\\b" + savedSettings.matching[name] + "\\b", "i"))) {
                sendMessage("Found a match for " + savedSettings.matching[name] + " in " + offerName.rawText + "\nhttps://lastbottlewines.com")
                    .then(function(data)
                    {
                        console.log("We got some data");
                        console.log(data);                    
                    })
                    .catch(function(err)
                    {
                        logError(err);
                    });
                return;
            }
        }
        if (!!reportNothing) 
            sendMessage("No matching terms in '" + offerName.rawText + "'");
        console.log("No matching terms for '" + offerName.rawText + "'");
    })
    .catch((e) => {
        console.log(e);
    });
}

var runOnce = false;
if (process.argv.length > 2) {
    if (process.argv[2] == "runonce") {
        runOnce = true;
    } else if (process.argv[2] == "ping") {
        sendMessage("Starting up at " + (new Date()))
    }
}

// load settings from redis
// is the redis server in a default state?  if so, init with defaults
getAsync('watch-lb-settings').then((res) => {
    if (!res) {
        // initialize matching
        console.log("Initializing from defaults");
        saveSettings();
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
            savedSettings.defaultRate = (process.env.CHECK_RATE || 15);
            saveSettings();
        }
        runtimeSettings.intervalTimer = setInterval(checkWines, 1000*60*savedSettings.defaultRate);
    }

    // does it look like the system just started?
    if (os.uptime() < 5*60) {
        sendMessage("Looks like the system just restarted, uptime is " + os.uptime());
    }

    // just in case, run an initial check.  with all of the caching we're doing, 
    // we should not be over-communicating
    checkWines();
});
