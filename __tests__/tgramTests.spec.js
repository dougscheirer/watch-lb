const { watchRuntime } = require('../functions');
const redis = require("redis-mock");
const fs = require('fs');
const tgramMock = require('../__mocks__/tgramMock');

var sendMessages = [];
var watcher = null;
var api = null;

function logCapture() {
  // don't spit out watcher messages
}

function initWatcher() {
  api = new tgramMock("chatid", function (chatid, msg) { sendMessages.push({ chatid: chatid, message: msg }); });
  client = redis.createClient();
  watcher = new watchRuntime(api, client, "chatid");
  watcher.logger = logCapture;
}

function loadWatcher(fetchFunc) {
  initWatcher();
  watcher.fetchUrl = fetchFunc;
  return watcher.loadSettings(false);
}

function loadGoodTest() {
  return loadWatcher(async (url) => {
    var body;
    try {
      body = fs.readFileSync("./testdata/good.html").toString();
    } catch (e) { 
      console.log("error:" + e); 
    }
    return { statusCode: 200, body: body, headers: [{ result: "pie" }] };
  });
}

function loadBadTest() {
  return loadWatcher(async (url) => {
    // console.log("got a call for " + url);
    return { statusCode: 500, body: null, headers: [{ result: "pie" }] };
  });
}

beforeEach(() => {
  sendMessages = [];
});

afterEach(() => {
  console.log("SENT MESSAGES: ");
  console.log(sendMessages);
  sendMessages = [];
});

test('sendMessage', (done) => {
  return loadGoodTest().then(() => {
    watcher.sendMessage("this is a pizza");
    expect(sendMessages.length).toEqual(1);
    expect(sendMessages[0].message).toEqual("this is a pizza");
    done();
  })
});

test('/now positive result', (done) => {
  return loadGoodTest().then(() => {
    api.testTextReceived('/now').then((res) => {
      expect(sendMessages.length).toEqual(1);
      expect(sendMessages[0].message).toEqual("Found a match for cabernet in Groth Oakville Cabernet Sauvignon Reserve 2015\nhttps://lastbottlewines.com");
      done();
    });
  })
});

test('/now no result', (done) => {
  return loadBadTest().then(() => {
    api.testTextReceived('/now');
    expect(sendMessages.length).toEqual(1);
    expect(sendMessages[0].message).toEqual("No matches found for ...");
    done();
  })
});

test('/now page error', (done) => {
  return loadBadTest().then(() => {
    api.testTextReceived('/now');
    expect(sendMessages.length).toEqual(1);
    expect(sendMessages[0].message).toEqual("Fetch error: 500");
    done();
  })
});

test('/status', (done) => {
  return loadGoodTest().then(() => {
    api.testTextReceived('/status');
    expect(sendMessages.length).toEqual(1);
    const regex=/Last check at (.*)\nLast difference at (.*)/
    expect(regex.test(sendMessages[0].message)).toBeTruthy();
    done();
  })
});
