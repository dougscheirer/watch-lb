const { watchRuntime } = require('../functions');
const redis = require("redis-mock");

const tgramMock = require('../__mocks__/tgramMock');

var sendMessages = [];
var watcher = null;
var api = null;

function initWatcher() {
  api = new tgramMock("chatid", function (chatid, msg) { sendMessages.push({ chatid: chatid, message: msg }); });
  client = redis.createClient();
  watcher = new watchRuntime(api, client, "chatid");
}

function loadWatcher(fetchFunc) {
  initWatcher();
  watcher.fetchUrl = fetchFunc;
  return watcher.loadSettings(false).then(() => {
    console.log("loadWatcher is loaded");
  });
}

function loadGoodTest() {
  return loadWatcher(async (url) => {
    console.log("got a call for " + url);
    return { statusCode: 200, body: "this is pizza", headers: [{ result: "pie" }] };
  });
}

function loadBadTest() {
  return loadWatcher(async (url) => {
    console.log("got a call for " + url);
    return { statusCode: 200, body: "this is pizza", headers: [{ result: "pie" }] };
  });
}

beforeEach(() => {
  sendMessages = [];
});

afterEach(() => {
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
    api.testTextReceived('/now');
    console.log(sendMessages);
    done();
  })
});

test('/now page error', (done) => {
  return loadBadTest().then(() => {
    api.testTextReceived('/now');
    console.log(sendMessages);
    done();
  })
});

test('/now page error', (done) => {
  return loadBadTest().then(() => {
    api.testTextReceived('/now');
    console.log(sendMessages);
    done();
  })
});

test('/status', (done) => {
  return loadGoodTest().then(() => {
    api.testTextReceived('/status');
    console.log(sendMessages);
    expect(1).toEqual(0);
    done();
  })
});

