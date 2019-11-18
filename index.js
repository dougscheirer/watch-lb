const wget = require('node-wget');
const parser = require('node-html-parser');
const telegram = require('node-telegram-bot-api');

const api = new telegram('920777061:AAEbXZJbtBEBCFQk-UFqWYYyKaRz4FO8614');
 
// a telegram test
const bot = new telegram('920777061:AAEbXZJbtBEBCFQk-UFqWYYyKaRz4FO8614', {polling: true});
bot.onText(/\/echo (.+)/, (msg, match) => {
    const chatId = msg.chat.id;
    const resp = match[1]; // the captured "whatever"
  
    console.log(msg);
    // send back the matched "whatever" to the chat
    bot.sendMessage(chatId, resp);
});
bot.on('message', (msg) => {
    console.log(message);
    bot.sendMessage(msg.chat.id, "Thanks for that");
});

wget("https://lastbottlewines.com", (err, resp, body) => {
    if (!!err) {
        // TODO: log the error somehow
    } else {
        // parse the body and look for the offer-name class
        const root = parser.parse(body);
        // TODO: catch parse errors
        const offerName = root.querySelector(".offer-name");
        console.log(offerName.rawText);
        // TODO: no offer name means something went wrong with the script
        const matching = ["bordeaux", "mounts", "rioja", "sryah", "noir"];
        for (name in matching) {
            if (offerName.rawText.match(new RegExp(matching[name], "i"))) {
                console.log("Found a match: " + matching[name]);
                api.sendMessage("@doug_scheirer",
                                "Found a match for " + matching[name] + " in " + offerName.rawText + "\nhttps://lastbottlewines.com")
                    .then(function(data)
                    {
                        console.log("We got some data: " + data);
                    })
                    .catch(function(err)
                    {
                        console.log("There was an error: " + err);
                    });
            }
        }
    }
});