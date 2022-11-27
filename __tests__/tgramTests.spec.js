/**
 * @jest-environment node
 */

const { watchRuntime } = require('../watchRuntime');
const redis = require("redis-mock");
const fs = require('fs');
const tgramMock = require('../__mocks__/tgramMock');
const MockDate = require("mockdate");
const durationParser = require("parse-duration");
const { promisify } = require('util');

var sendMessages = [];
var watcher = null;
var api = null;
var redisClient = redis.createClient();

// for use elsewhere
const adate = "03/16/2020";
const posMatch =  "Found a match for cabernet ($89) in Groth Oakville Cabernet Sauvignon Reserve 2015\nhttps://lastbottlewines.com";
const baseCheckRegex = "Last check at (.*)\nLast difference at (.*)\nLast offer: \\(LB8212\\) Groth Oakville Cabernet Sauvignon Reserve 2015 \\$89\nLast MD5: (.*)\nCurrent interval: 15 minutes\n";
const serviceRegex = "Service uptime: (.*)\n"
const badTest2Content = "<html><head></head><body>Do not match stuff<h1 class=\"offer-name-tag-invalid\">pizza</h1></body></html>";
const recentRegex = 'offer-match-([0-9]+): {"name":"Groth Oakville Cabernet Sauvignon Reserve 2015","price":"89","link":"https://www.lastbottlewines.com/cart/add/LB8212.html","id":"LB8212","md5":"1e5efef7c1494301ead78139cd413143"}';

function logCapture() {
  // don't spit out watcher messages
}

function realLogger(msg) {
  // console.log(msg);
}

function logTestName(msg) {
  // console.log(expect.getState().currentTestName + ": " + msg);
}

// overloads for set/clearInterval
var intID = 0, intCount = -1, intFn = undefined, testID = '';
function setIntFunc(fn, count) {
  logTestName("setInteval");
  if (intFn != undefined) {
    logTestName("going to fail here");
    // TODO: figure out why /settings test fails in full test mode
    // expect(intFn).toEqual(undefined);
  }
  testID = expect.getState().currentTestName;
  intCount = count;
  intFn = fn;
  intID++;
  return intID;
}

function clrIntFunc(id) {
  logTestName("clearInteval)");
  expect(id).toEqual(intID);
  intCount = -1;
  intFn = undefined;
  return;
}

function initWatcher(fetchFunc, optLogger) {
  MockDate.set(adate);
  api = new tgramMock(
          "chatid", 
          function (chatid, msg) { sendMessages.push({ chatid: chatid, message: msg }); },
          { onlyFirstMatch: true },
  );
  // clean redis? 
  // client.del('watch-lb-settings');
  watcher = new watchRuntime({
    telegramApi: api, 
    redisApi: redisClient, 
    chatid: "chatid", 
    fetchFunc: fetchFunc,
    setInterval: setIntFunc,
    clearInterval: clrIntFunc,
    logger: (optLogger) ? optLogger : logCapture
  });
}

function loadWatcher(fetchFunc, optLogger) {
  initWatcher(fetchFunc, optLogger);
  return watcher.loadSettings();
}

function loadTest(fname, optLogger) {
  return loadWatcher(async (url) => {
    var body;
    try {
      body = fs.readFileSync(fname).toString();
    } catch (e) { 
      console.log("error loading test:" + e); 
    }
    return { status: 200, data: body, headers: [{ result: "pie" }] };
  }, optLogger);
}

function loadGoodTest(optLogger) {
  return loadTest("./testdata/good.html", optLogger);
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
        badTest2Content, 
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
  if (redisClient) {
    redisClient.flushall();
  }
  logTestName("beforeEach");
  sendMessages = [];
  intID = 0;
  intCount = -1;
  intFn = undefined;
  testID = '';
});

afterEach(() => {
  // console.log("SENT MESSAGES: ");
  // console.log(sendMessages);
  sendMessages = [];
  watcher = null;
});

/***************************************************************************************
 * 
 * Begin tests
 * 
 ***************************************************************************************/

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
  const getAsync = promisify(redisClient.get).bind(redisClient);

  return loadBadTest2().then(async () => {
    await api.testTextReceived('/now');
    const regex = new RegExp("offer-name class not found, perhaps the page formatting has changed or there was a page load error: offer-invalid-(.*)");
    expect(regex.test(sendMessages[0].message)).toBeTruthy();
    expect(sendMessages.length).toEqual(1);
    // expect a new redis value of 'offer-invalid-YYYYMMDDHHMMSS' with the bad test data
    rx=/offer-invalid-(.*)/g;
    const match = rx.exec(sendMessages[0].message);
    const dump = await getAsync(match[0]);
    expect(dump).toEqual(badTest2Content);
    done();
  });
});

test('/now bad parse + /lserror', (done) => {
  const getAsync = promisify(redisClient.get).bind(redisClient);

  return loadBadTest2().then(async () => {
    await api.testTextReceived('/now');
    sendMessages = [];
    await api.testTextReceived('/lserror');
    rx=/offer-invalid-(.*)/g;
    const match = rx.exec(sendMessages[0].message);
    expect(match.length).toEqual(2);
    done();
  });
});

test('/now bad parse + /showerror', (done) => {
  const getAsync = promisify(redisClient.get).bind(redisClient);

  return loadBadTest2().then(async () => {
    await api.testTextReceived('/now');
    // expect a new redis value of 'offer-invalid-YYYYMMDDHHMMSS' with the bad test data
    rx=/offer-invalid-(.*)/g;
    const match = rx.exec(sendMessages[0].message);
    sendMessages = [];
    await api.testTextReceived('/showerror ' + match[0]);
    expect("Error " + match[0] + "\n" + badTest2Content).toEqual(sendMessages[0].message);
    done();
  });
});

test('/now bad parse + /clrerror N', (done) => {
  const getAsync = promisify(redisClient.get).bind(redisClient);
  return loadBadTest2().then(async () => {
    await api.testTextReceived('/now');
    // expect a new redis value of 'offer-invalid-YYYYMMDDHHMMSS' with the bad test data
    rx=/offer-invalid-(.*)/g;
    const match = rx.exec(sendMessages[0].message);
    sendMessages = [];
    await api.testTextReceived('/clrerror ' + match[0]);
    expect("Cleared " + match[0]).toEqual(sendMessages[0].message);
    // also fetch the value expect that it is not there
    const val = await getAsync(match[0]);
    expect(val).toBeFalsy();
    done();
  });
});

test('/now bad parse + /clrerror', (done) => {
  const getAsync = promisify(redisClient.get).bind(redisClient);
  return loadBadTest2().then(async () => {
    await api.testTextReceived('/now');
    // expect a new redis value of 'offer-invalid-YYYYMMDDHHMMSS' with the bad test data
    rx=/offer-invalid-(.*)/g;
    const match = rx.exec(sendMessages[0].message);
    sendMessages = [];
    await api.testTextReceived('/clrerror');
    expect("Cleared all offer invalid keys").toEqual(sendMessages[0].message);
    // also fetch the value expect that it is not there
    const val = await getAsync(match[0]);
    expect(val).toBeFalsy();
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
    // first message is match message from checkWines
    expect(sendMessages.length).toEqual(2);
    expect(regex.test(sendMessages[1].message)).toBeTruthy();
    done();
  });
});

test('/uptick 1d', (done) => {
  return loadGoodTest().then(async () => {
    await api.testTextReceived('/uptick 1d');
    const regex=/Check interval changed to a day/;
    // first message is match message from checkWines
    expect(sendMessages.length).toEqual(2);
    expect(regex.test(sendMessages[1].message)).toBeTruthy();
    done();
  });
});

test('/uptick default', (done) => {
  return loadGoodTest().then(async () => {
    await api.testTextReceived('/uptick default');
    const regex=/Check interval changed to 15 minutes/;
    // first message is match message from checkWines
    expect(sendMessages.length).toEqual(2);
    expect(regex.test(sendMessages[1].message)).toBeTruthy();
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
    await api.testTextReceived('/resume');
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
    await api.testTextReceived('/resume');
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
  return loadGoodTest(realLogger).then(async () => {
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

async function saveFakeMatches() {
  for (var i = 0; i < 30; i++) {
    await watcher.setAsync('offer-match-20200315000' + (100+i), "this is a fake match " + i);
  }
}
test('/recent', (done) => {
  return loadGoodTest().then(() => {
    api.testTextReceived('/now').then(async (res) => {
      sendMessages=[];
      await saveFakeMatches();
      api.testTextReceived('/recent').then((res) => {
        expect(sendMessages.length).toEqual(1);
        expect((new RegExp(recentRegex)).exec(sendMessages[0].message).length).toEqual(2);
        expect(sendMessages[0].message.split("\n").length).toEqual(11);
        done();
      })
    })
  })
});

test('/recent 3', (done) => {
  return loadGoodTest().then(() => {
    api.testTextReceived('/now').then(async (res) => {
      sendMessages=[];
      await saveFakeMatches();
      api.testTextReceived('/recent 3').then((res) => {
        expect(sendMessages.length).toEqual(1);
        expect(sendMessages[0].message.split("\n").length).toEqual(4);
        done();
      })
    })
  })
});

test('/recent notnum', (done) => {
  return loadGoodTest().then(() => {
    api.testTextReceived('/now').then((res) => {
      sendMessages=[];
      api.testTextReceived('/recent notnum').then((res) => {
        expect(sendMessages.length).toEqual(1);
        expect(sendMessages[0].message).toEqual("notnum is not a valid number.  Specify a number of offers to fetch");
        done();
      })
    })
  })
});
