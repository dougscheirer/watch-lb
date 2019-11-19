const curl = new (require( 'curl-request' ))();
const parser = require('node-html-parser');
const telegram = require('node-telegram-bot-api');
const crypto = require('crypto');

// console.log(process.env);

const api = new telegram(process.env.API_TOKEN);

function logError(message) {
    console.log("ERROR >>>");   
    console.log(message);
    sendMessage(message);
}

function sendMessage(message) {
    console.log("Sending message: " + message);
    return api.sendMessage(process.env.CHAT_ID, message);
}

var lastMD5 = null;
var lastMD5Update = null;

function checkWines() {
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
            console.log("No changes, skipping");
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

        const matching = ["bordeaux", "mounts", "trespass", "cabernet", "franc", "rioja", "sryah"];
        for (name in matching) {
            if (offerName.rawText.match(new RegExp(matching[name], "i"))) {
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
        // sendMessage("No matching terms for '" + offerName.rawText + "'");
        console.log("No matching terms for '" + offerName.rawText + "'");
    })
    .catch((e) => {
        console.log(e);
    });
}

if (process.argv.length > 2 && process.argv[2] == "runonce") {
    checkWines();
} else {
    // start one to initiate the process
    checkWines();
    // env CHECK_RATE in minutes or 15 
    setInterval(checkWines, 1000*60*(process.env.CHECK_RATE || 15));
}

