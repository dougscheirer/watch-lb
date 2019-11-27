// .env reader
require('dotenv').config()

const curl = new (require( 'curl-request' ))();
const parser = require('node-html-parser');
const telegram = require('node-telegram-bot-api');
const crypto = require('crypto');
const os = require('os');
const mjs = require('moment');

const api = new telegram(process.env.API_TOKEN, {polling: true} );

var intervalTimer = null;
var lastMD5 = null;
var lastMD5Update = null;
var lastIntervalUpdate = null;
var defaultRate = null;
var sent24hrMessage = false;

var matching = [ "bordeaux", "mounts", "trespass", "cabernet", "franc", "rioja", "syrah", "emilion", "les ormes", "petit" ];

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


function sendList() {
    sendMessage("Current search terms:\n" + matching.join("\n"));
}

// /list
api.onText(/\/list/, (msg, match) => {
    sendList();
});

// /add (term)
api.onText(/\/add (.+)/, (msg, match) => {
    const toAdd = match[1].toLowerCase();
    if (matching.indexOf(toAdd) >= 0 ) {
        sendMessage(toAdd + " is already a search term");
        return;
    }
    matching.push(toAdd);
    sendList();
    // invalidate the MD5 cache
    lastMD5 = null;
    lastMD5Update = null;
    checkWines(true);
});

// /remove (term)
api.onText(/\/del (.+)/, (msg, match) => {
    const toDel = match[1].toLowerCase();
    if (matching.indexOf(toDel) < 0 ) {
        sendMessage(toDel + " is not a search term");
        return;
    }
    matching.splice(matching.indexOf(toDel));
    sendList();
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
    sendMessage("Check interval changed to " + number + " minutes");
});

function logError(message) {
    console.log("ERROR >>>");   
    console.log(message);
    sendMessage(message);
}

function sendMessage(message) {
    console.log("Sending message: " + message);
    return api.sendMessage(process.env.CHAT_ID, message);
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
        if (!reportNothing && hash == lastMD5) {
            console.log("No changes since last update");
            if (lastMD5Update != null) {
                console.log("Time since last change: " + ((new Date()) - lastMD5Update));
                // how long since it changed?  are we not getting updates?
                if (!sent24hrMessage && ((new Date()) - lastMD5Update) > 24*60*60*1000) {
                    sent24hrMessage = true;
                    sendMessage("No updates for more than 24h");
                }
            }
            return;
        }

        // remember the MD5
        sent24hrMessage=false;
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

// does it look like the system just started?

if (os.uptime() < 5*60) {
    sendMessage("Looks like the system just restarted, uptime is " + os.uptime());
    // just in case, run an initial check
    checkWines();
}

if (!runOnce) {  // env CHECK_RATE in minutes or 15
    defaultRate = process.env.CHECK_RATE || 15;
    intervalTimer = setInterval(checkWines, 1000*60*defaultRate);
}



