const { watchRuntime } = require('../watchRuntime');
const redis = require("redis-mock");
const fs = require('fs');
const tgramMock = require('../__mocks__/tgramMock');
const { syncBuiltinESMExports } = require('module');
const MockDate = require("mockdate");
const durationParser = require("parse-duration");

var sendMessages = [];
var watcher = null;
var api = null;
var redisClient = null;

// for use elsewhere
const adate = "03/16/2020";
const posMatch =  "Found a match for cabernet ($89) in Groth Oakville Cabernet Sauvignon Reserve 2015\nhttps://lastbottlewines.com";
const baseCheckRegex = "Last check at (.*)\nLast difference at (.*)\nLast offer: \\(LB8212\\) Groth Oakville Cabernet Sauvignon Reserve 2015 \\$89\nLast MD5: (.*)\nCurrent interval: 15 minutes\n";
const serviceRegex = "Service uptime: (.*)\n"

function logCapture() {
  // don't spit out watcher messages
}

function initWatcher(fetchFunc) {
  MockDate.set(adate);
  api = new tgramMock(
          "chatid", 
          function (chatid, msg) { sendMessages.push({ chatid: chatid, message: msg }); },
          { onlyFirstMatch: true },
  );
  var client = redis.createClient();
  redisClient = client;
  // clean redis? 
  // client.del('watch-lb-settings');
  watcher = new watchRuntime({
    telegramApi: api, 
    redisApi: client, 
    chatid: "chatid", 
    fetchFunc: fetchFunc});
  watcher.logger = logCapture;
}

function loadWatcher(fetchFunc) {
  initWatcher(fetchFunc);
  return watcher.loadSettings(false);
}

function loadTest(fname) {
  return loadWatcher(async (url) => {
    var body;
    try {
      body = fs.readFileSync(fname).toString();
    } catch (e) { 
      console.log("error loading test:" + e); 
    }
    return { status: 200, data: body, headers: [{ result: "pie" }] };
  });
}

function loadGoodTest() {
  return loadTest("./testdata/good.html");
}

function loadBadTest() {
  return loadWatcher(async (url) => {
      // console.log("got a call for " + url);
      return { status: 200, data: 
        "<html><head></head><body>Do not match stuff<h1 class=\"offer-name\">pizza</h1></body></html>", 
        headers: [{ result: "pie" }] };
      });
}

function loadBadTest2() {
  return loadWatcher(async (url) => {
      // console.log("got a call for " + url);
      return { status: 200, data: 
        "<html><head></head><body>Do not match stuff<h1 class=\"offer-name-tag-invalid\">pizza</h1></body></html>", 
        headers: [{ result: "pie" }] };
      });
}

function loadFetchError() {
  return loadWatcher(async (url) => {
      // console.log("got a call for " + url);
      return { status: 404, data: null, headers: [{ result: "pie" }] };
    });
  }
  
beforeEach(() => {
  sendMessages = [];
});

afterEach(() => {
  // console.log("SENT MESSAGES: ");
  // console.log(sendMessages);
  sendMessages = [];
  watcher = null;
});

test('sendMessage', (done) => {
  return loadGoodTest().then(() => {
    watcher.sendMessage("this is a pizza");
    expect(sendMessages[0].message).toEqual("this is a pizza");
    expect(sendMessages.length).toEqual(1);
    done();
  });
});

test('/now positive result', (done) => {
  return loadGoodTest().then(() => {
    api.testTextReceived('/now').then((res) => {
      expect(sendMessages[0].message).toEqual(posMatch);
      expect(sendMessages.length).toEqual(1);
      done();
    });
  });
});

test('/now no result', (done) => {
  return loadBadTest().then(async () => {
    await api.testTextReceived('/now');
    expect(sendMessages[0].message).toEqual("No matching terms in 'pizza'");
    expect(sendMessages.length).toEqual(1);
    done();
  });
});


test('/now bad parse', (done) => {
  return loadBadTest2().then(async () => {
    await api.testTextReceived('/now');
    const regex = new RegExp("offer-name class not found, perhaps the page formatting has changed or there was a page load error: offer-invalid-(.*)");
    expect(regex.test(sendMessages[0].message)).toBeTruthy();
    expect(sendMessages.length).toEqual(1);
    // expect a new redis value of 'offer-invalid-YYYYMMDDHHMMSS' with the bad test data
    console.log(redisClient);
    done();
  });
});

test('/now near-duplicate no result', (done) => {
  return loadGoodTest().then(async () => {
    await watcher.checkWines();
    // should have a match message
    expect(sendMessages[0].message).toEqual(posMatch);
    // modify the MD5 but leave the content the same
    watcher.savedSettings.lastMD5 = "";
    await watcher.checkWines();
    // should get no message
    expect(sendMessages.length).toEqual(1);
    done();
  });
});

test('/now page error', (done) => {
  return loadFetchError().then(async () => {
    await api.testTextReceived('/now');
    expect(sendMessages[0].message).toEqual("Fetch error: 404");
    expect(sendMessages.length).toEqual(1);
    done();
  });
});

test('/status', (done) => {
  return loadGoodTest().then(async () => {
    await watcher.checkWines();
    sendMessages=[];
    await api.testTextReceived('/status');
    const regex = new RegExp(baseCheckRegex + serviceRegex + "git: (.*)");
    // console.log(sendMessages[0].message);
    expect(regex.test(sendMessages[0].message)).toBeTruthy();
    expect(sendMessages.length).toEqual(1);
    done();
  });
});

test('/status with 0 start time', (done) => {
  return loadGoodTest().then(async () => {
    await watcher.checkWines();
    watcher.runtimeSettings.startTime = new Date();
    sendMessages=[];
    await api.testTextReceived('/status');
    const regex = new RegExp(baseCheckRegex + "Service uptime: a few seconds\ngit: (.*)");
    expect(regex.test(sendMessages[0].message)).toBeTruthy();
    expect(sendMessages.length).toEqual(1);
    done();
  });
});

test('/status with 5m start time', (done) => {
  return loadGoodTest().then(async () => {
    await watcher.checkWines();
    watcher.runtimeSettings.startTime = new Date(new Date() - 5*60*1000);
    sendMessages=[];
    await api.testTextReceived('/status');
    const regex = new RegExp(baseCheckRegex + "Service uptime: 5 minutes\ngit: (.*)");
    expect(regex.test(sendMessages[0].message)).toBeTruthy();
    expect(sendMessages.length).toEqual(1);
    done();
  });
});

test('/status paused forever', (done) => {
  return loadGoodTest().then(async () => {
    await watcher.checkWines();
    await api.testTextReceived('/pause');
    sendMessages=[];
    await api.testTextReceived('/status');
    const regex = new RegExp(baseCheckRegex + "Service uptime: (.*)\nPaused until forever");
    expect(regex.test(sendMessages[0].message)).toBeTruthy();
    expect(sendMessages.length).toEqual(1);
    done();
  });
});

test('/status paused for a while', (done) => {
  return loadGoodTest().then(async () => {
    await watcher.checkWines();
    await api.testTextReceived('/pause 15d');
    sendMessages=[];
    await api.testTextReceived('/status');
    const regex = new RegExp(baseCheckRegex + "Service uptime: (.*)\nPaused until ");
    expect(regex.test(sendMessages[0].message)).toBeTruthy();
    expect(sendMessages.length).toEqual(1);
    done();
  });
});

test('/list', (done) => {
  return loadGoodTest().then(async () => {
    await api.testTextReceived('/list');
    const regex=/cabernet/;
    expect(regex.test(sendMessages[0].message)).toBeTruthy();
    expect(sendMessages.length).toEqual(1);
    done();
  });
});

test('/list default', (done) => {
  return loadGoodTest().then(async () => {
    // first add something
    const regex=/pizza/;
    await api.testTextReceived("/add pizza");
    expect(regex.test(sendMessages[0].message)).toBeTruthy();
    sendMessages = [];
    await api.testTextReceived("/list");
    expect(regex.test(sendMessages[0].message)).toBeTruthy();
    sendMessages = [];
    await api.testTextReceived('/list default');
    expect(regex.test(sendMessages[0].message)).toBeFalsy();
    done();
  });
});

test('/uptick 3', (done) => {
  return loadGoodTest().then(async () => {
    await api.testTextReceived('/uptick 3');
    const regex=/Check interval changed to 3 minutes/;
    expect(regex.test(sendMessages[0].message)).toBeTruthy();
    // expect(sendMessages.length).toEqual(2);
    done();
  });
});

test('/uptick 1d', (done) => {
  return loadGoodTest().then(async () => {
    await api.testTextReceived('/uptick 1d');
    const regex=/Check interval changed to a day/;
    expect(regex.test(sendMessages[0].message)).toBeTruthy();
    // expect(sendMessages.length).toEqual(2);
    done();
  });
});

test('/uptick default', (done) => {
  return loadGoodTest().then(async () => {
    await api.testTextReceived('/uptick default');
    const regex=/Check interval changed to 15 minutes/;
    expect(regex.test(sendMessages[0].message)).toBeTruthy();
    // expect(sendMessages.length).toEqual(2);
    done();
  });
});

test('/uptick nothing', (done) => {
  return loadGoodTest().then(async () => {
    await api.testTextReceived('/uptick nothing');
    const regex=/nothing is not a valid number/;
    expect(regex.test(sendMessages[0].message)).toBeTruthy();
    // expect(sendMessages.length).toEqual(1);
    done();
  });
});

test('/start', (done) => {
  return loadGoodTest().then(async () => {
    await api.testTextReceived('/start');
    const regex=/Your chat id is chatid/;
    expect(regex.test(sendMessages[0].message)).toBeTruthy();
    expect(sendMessages.length).toEqual(1);
    done();
  });
});

test('/add pizza', (done) => {
  return loadGoodTest().then(async () => {
    await api.testTextReceived('/add pizza');
    const regex=/pizza/;
    expect(regex.test(sendMessages[0].message)).toBeTruthy();
    expect(sendMessages.length).toEqual(2);
    expect(/Found a match/.test(sendMessages[1].message)).toBeTruthy();
    done();
  });
});

test('/add cabernet', (done) => {
  return loadGoodTest().then(async () => {
    await api.testTextReceived('/add cabernet');
    const regex=/already a search term/;
    expect(regex.test(sendMessages[0].message)).toBeTruthy();
    expect(sendMessages.length).toEqual(1);
    done();
  });
});

test('/del cabernet', (done) => {
  return loadGoodTest().then(async () => {
    await api.testTextReceived('/del cabernet');
    const regex=/cabernet/;
    expect(regex.test(sendMessages[0].message)).toBeFalsy();
    expect(sendMessages.length).toEqual(2);
    done();
  });
});

test('/del pizza', (done) => {
  return loadGoodTest().then(async () => {
    await api.testTextReceived('/del pizza');
    const regex=/is not a search term/;
    expect(regex.test(sendMessages[0].message)).toBeTruthy();
    expect(sendMessages.length).toEqual(1);
    done();
  });
});

test('/pause', (done) => {
  return loadGoodTest().then(async () => {
    await api.testTextReceived('/pause');
    const regex=/Pausing until forever/;
    expect(regex.test(sendMessages[0].message)).toBeTruthy();
    expect(sendMessages.length).toEqual(1);
    // make sure it will not check
    sendMessages=[];
    watcher.checkWines(true);
    const regex2=/Paused, use \/resume to restart/;
    expect(regex2.test(sendMessages[0].message)).toBeTruthy();
    expect(sendMessages.length).toEqual(1);
    // resume
    sendMessages=[];
    api.testTextReceived('/resume');
    const regex3=/Resuming with check interval of/;
    expect(regex3.test(sendMessages[0].message)).toBeTruthy();
    expect(sendMessages.length).toEqual(1);
    done();
  });
});

test('/pause 2 weeks and resume', (done) => {
  return loadGoodTest().then(async () => {
    await api.testTextReceived('/pause 2 weeks');
    const regex=/Pausing until/;
    expect(regex.test(sendMessages[0].message)).toBeTruthy();
    expect(sendMessages.length).toEqual(1);
    // make sure it will not check
    sendMessages=[];
    watcher.checkWines(true);
    const regex2=/Paused, will resume on/;
    expect(regex2.test(sendMessages[0].message)).toBeTruthy();
    expect(sendMessages.length).toEqual(1);
    // resume
    sendMessages=[];
    api.testTextReceived('/resume');
    const regex3=/Resuming with check interval of/;
    expect(regex3.test(sendMessages[0].message)).toBeTruthy();
    expect(sendMessages.length).toEqual(1);
    done();
  });
});

test('/pause 2 weeks', (done) => {
  return loadGoodTest().then(async () => {
    await api.testTextReceived('/pause 2 weeks');
    const regex=/Pausing until/;
    expect(regex.test(sendMessages[0].message)).toBeTruthy();
    expect(sendMessages.length).toEqual(1);
    // make sure it will not check
    sendMessages=[];
    await watcher.checkWines(true);
    const regex2=/Paused, will resume on/;
    expect(regex2.test(sendMessages[0].message)).toBeTruthy();
    expect(sendMessages.length).toEqual(1);
    // advance clock >2 weeks
    MockDate.set(new Date(adate).getTime() + durationParser("2 weeks") + durationParser("1 minute"));
    sendMessages=[];
    await watcher.checkWines(true);
    expect(sendMessages[0].message).toEqual(posMatch);
    expect(sendMessages.length).toEqual(1);
    done();
  });
});

test('/pause 1 day with datestamp', (done) => {
  return loadGoodTest().then(async () => {
    const now = new Date();
    const dateString = (now.getMonth()+1) + '/' + (now.getDate()+1) + '/' + now.getFullYear();
    await api.testTextReceived('/pause ' + dateString);
    const regex=/Pausing until/;
    expect(regex.test(sendMessages[0].message)).toBeTruthy();
    expect(sendMessages.length).toEqual(1);
    // make sure it will not check
    sendMessages=[];
    await watcher.checkWines(true);
    const regex2=/Paused, will resume on/;
    expect(regex2.test(sendMessages[0].message)).toBeTruthy();
    expect(sendMessages.length).toEqual(1);
    // advance clock >1 day
    MockDate.set(new Date(adate).getTime() + durationParser("1 day") + durationParser("1 minute"));
    sendMessages=[];
    await watcher.checkWines(true);
    expect(sendMessages[0].message).toEqual(posMatch);
    expect(sendMessages.length).toEqual(1);
    done();
  });
});

test('/pause 1 hour with timestamp', (done) => {
  return loadGoodTest().then(async () => {
    const now = new Date();
    const dateString = (now.getMonth()+1) + '/' + (now.getDate()+1) + '/' + now.getFullYear();
    await api.testTextReceived('/pause ' + dateString);
    const regex=/Pausing until/;
    expect(regex.test(sendMessages[0].message)).toBeTruthy();
    expect(sendMessages.length).toEqual(1);
    // make sure it will not check
    sendMessages=[];
    await watcher.checkWines(true);
    const regex2=/Paused, will resume on/;
    expect(regex2.test(sendMessages[0].message)).toBeTruthy();
    expect(sendMessages.length).toEqual(1);
    // advance clock >1 day
    MockDate.set(new Date(adate).getTime() + durationParser("1 day") + durationParser("1 minute"));
    sendMessages=[];
    await watcher.checkWines(true);
    expect(sendMessages[0].message).toEqual(posMatch);
    expect(sendMessages.length).toEqual(1);
    done();
  });
});

test('/pause with unparsable', (done) => {
  return loadGoodTest().then(async () => {
    const now = new Date();
    const dateString = " no idea";
    await api.testTextReceived('/pause ' + dateString);
    const regex=new RegExp('Unrecognized pause argument');
    expect(regex.test(sendMessages[0].message)).toBeTruthy();
    expect(sendMessages.length).toEqual(1);
    // make sure it will still check
    sendMessages=[];
    await watcher.checkWines(true);
    expect(sendMessages[0].message).toEqual(posMatch);
    expect(sendMessages.length).toEqual(1);
    done();
  });
});

test('/pause and reload', (done) => {
  return loadGoodTest().then(async () => {
    await api.testTextReceived('/pause 2 weeks');
    const regex=/Pausing until/;
    expect(regex.test(sendMessages[0].message)).toBeTruthy();
    expect(sendMessages.length).toEqual(1);
    // make sure it will not check
    sendMessages=[];
    watcher.checkWines(true);
    const regex2=/Paused, will resume on/;
    expect(regex2.test(sendMessages[0].message)).toBeTruthy();
    expect(sendMessages.length).toEqual(1);
    // reload
    watcher.loadSettings(false);
    sendMessages=[];
    watcher.checkWines(true);
    sendMessages=[];
    await api.testTextReceived('/status');
    const regex3=/Never checked\nCurrent interval: 15 minutes\nService uptime: (.*)\nPaused until /;
    expect(regex3.test(sendMessages[0].message)).toBeTruthy();
    expect(sendMessages[0].message.includes("forever") == false).toBeTruthy();
    expect(sendMessages.length).toEqual(1);
    done();
  });
});

test('/settings', (done) => {
  return loadGoodTest().then(async () => {
    await api.testTextReceived('/settings');
    expect(sendMessages.length).toEqual(1);
    var settingsJson = null;
    try {
      settingsJson = JSON.parse(sendMessages[0].message);
    } catch (e) {
      expect(e).toBeFalsy(); // we failed
    }
    done();
  });
});

test('/badcmd', (done) => {
  return loadGoodTest().then(async () => {
    await api.testTextReceived('/badcmd');
    expect(sendMessages.length).toEqual(1);
    expect(sendMessages[0].message).toEqual("Unknown command");
    done();
  });
});

test('updated page test', (done) => {
  return loadTest("./testdata/updated-purchase.html").then(async () => {
    await watcher.checkWines();
    sendMessages=[];
    await api.testTextReceived('/status');
    const regex = /Last check at (.*)\nLast difference at (.*)\nLast offer: \(LB3FAARE\) Beau Vigne Old Rutherford Cabernet Sauvignon Napa Valley 2019 \$49\nLast MD5: (.*)\nCurrent interval: 15 minutes\nService uptime: (.*)\n/;
    // console.log(sendMessages[0].message);
    expect(regex.test(sendMessages[0].message)).toBeTruthy();
    expect(sendMessages.length).toEqual(1);
    done();
  });
});

test('test with actual web fetch', (done) => {
  initWatcher();
  return watcher.loadSettings(false).then(async () => {
    try {
      await watcher.checkWines(true);
      expect(sendMessages.length).toEqual(1);
      // console.log(sendMessages);
    } catch (e) {
      console.log(e);
    }
    done();
  })
});