// .env reader
require('dotenv').config()
const curl = new (require( 'curl-request' ))();
const parser = require('node-html-parser');
const telegram = require('node-telegram-bot-api');
const crypto = require('crypto');
const os = require('os');
const mjs = require('moment');
var redis = require("redis");
const {promisify} = require('util');

// determine redis host from environment and connect
const opts = { host: process.env.REDIS_HOST || "localhost" };
const client = redis.createClient(opts);
const getAsync = promisify(client.get).bind(client);

// connect to telegram
const api = (process.env.NO_TELEGRAM != 1) ? new telegram(process.env.API_TOKEN, {polling: true} ) : null;

var intervalTimer = null;
var lastMD5 = null;
var lastMD5Update = null;
var lastIntervalUpdate = null;
var defaultRate = null;

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
var matching = null;

if (api) {
    // /start
    api.onText(/\/start/, (msg, match) => {
        const chatId = msg.chat.id;
    
        sendMessage("Your chat id is " + chatId);
    });

    // /status
    api.onText(/\/status/, (msg, match) => {
        const duration = mjs.duration(lastIntervalUpdate - lastMD5Update);
        if (lastMD5Update == null) {
            sendMessage("Never checked");
            return;
        }
        sendMessage("Last check at " + lastIntervalUpdate + "\nLast difference at " + lastMD5Update + " (" + duration.humanize() + ")");
        console.log(msg);
        console.log(msg.chat);
    });

    // /list
    api.onText(/\/list/, (msg, match) => {
        sendMessage("Current search terms:\n" + matching.join("\n"));
    });

    // /add (term)
    api.onText(/\/add (.+)/, (msg, match) => {
        const toAdd = match[1].toLowerCase();
        if (matching.indexOf(toAdd) >= 0 ) {
            sendMessage(toAdd + " is already a search term");
            return;
        }
        matching.push(toAdd);
        // write to redis
        client.set("matching", JSON.stringify(matching));
        // invalidate the MD5 cache
        lastMD5 = null;
        lastMD5Update = null;
        checkWines(true);
    });

    // /del (term)
    api.onText(/\/del (.+)/, (msg, match) => {
        const toDel = match[1].toLowerCase();
        if (matching.indexOf(toDel) < 0 ) {
            sendMessage(toDel + " is not a search term");
            return;
        }
        matching.splice(toDel, 1);
        // write to redis
        client.set("matching", JSON.stringify(matching));
        // invalidate the MD5 cache
        lastMD5 = null;
        lastMD5Update = null;
        checkWines(true);
    });
    
    // /now
    api.onText(/\/now/, (msg, match) => {
        checkWines(true);
    });

    // /uptick (time | default)"
    api.onText(/\/uptick (.+)/, (msg, match) => {
        var number = null;
        if (match[1] == "default") {
            number = defaultRate;
        } else {
            number = parseInt(match[1]);
        }

        if (!number) {
            sendMessage(match[1] + " is not a number.  Specify a number of minutes to change the check interval");
            return;
        }
    
        // increase the frequency of checks to (match) minutes
        clearInterval(intervalTimer);
        checkWines();
        intervalTimer = setInterval(checkWines, number*1000*60);
        // save the last setting
        client.set('defaultRate', number);
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
    lastIntervalUpdate = new Date();
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
        if (hash == lastMD5) {
            if (!!reportNothing) {
                sendMessage("No changes since last update");
            }
            console.log("No changes since last update");
            if (lastMD5Update != null) {
                console.log("Time since last change: " + ((new Date()) - lastMD5Update));
                // how long since it changed?  are we not getting updates?
                if (((new Date()) - lastMD5Update) > 24*60*60*1000) {
                    sendMessage("No updates for more than 24h");
                }
            }
            return;
        }
        // remember the MD5
        lastMD5=hash;
        lastMD5Update=new Date();

        for (name in matching) {
            if (body.match(new RegExp(matching[name], "i"))) {
                sendMessage("Found a match for " + matching[name] + " in " + offerName.rawText + "\nhttps://lastbottlewines.com")
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

// is the redis server in a default state?  if so, init with defaults
getAsync('matching').then((res) => {
    console.log('matching: ' + res);
    if (!res) {
        // initialize matching
        console.log("Initializing from defaults");
        matching = matching_default;
        client.set("matching", JSON.stringify(matching));
    } else {
        matching = JSON.parse(res);
        // make sure matching_default is the minimum
        for (m in matching_default)  {  
            if (matching_default.indexOf(m) < 0)
                matching.push(m);
        }
    }
})

// just do a test run?
if (!runOnce) {  
    getAsync('defaultRate').then((res) => {
	console.log("defaultRate is " + res);
        defaultRate = (res) ? res : (process.env.CHECK_RATE || 15);
        intervalTimer = setInterval(checkWines, 1000*60*defaultRate);
    });
}

// TODO: store other things in redis

// does it look like the system just started?
if (os.uptime() < 5*60) {
    sendMessage("Looks like the system just restarted, uptime is " + os.uptime());
    // just in case, run an initial check
    checkWines();
}




