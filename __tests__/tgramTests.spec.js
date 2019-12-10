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
    return { statusCode: 200, body: 
      "<html><head></head><body>Do not match stuff<h1 class=\"offer-name\">pizza</h1></body></html>", 
      headers: [{ result: "pie" }] };
  });
}

function loadFetchError() {
  return loadWatcher(async (url) => {
    // console.log("got a call for " + url);
    return { statusCode: 404, body: null, headers: [{ result: "pie" }] };
  });
}

beforeEach(() => {
  sendMessages = [];
});

afterEach(() => {
  // console.log("SENT MESSAGES: ");
  // console.log(sendMessages);
  sendMessages = [];
});

test('sendMessage', (done) => {
  return loadGoodTest().then(() => {
    watcher.sendMessage("this is a pizza");
    expect(sendMessages[0].message).toEqual("this is a pizza");
    expect(sendMessages.length).toEqual(1);
    done();
  })
});

test('/now positive result', (done) => {
  return loadGoodTest().then(() => {
    api.testTextReceived('/now').then((res) => {
      expect(sendMessages[0].message).toEqual("Found a match for cabernet in Groth Oakville Cabernet Sauvignon Reserve 2015\nhttps://lastbottlewines.com");
      expect(sendMessages.length).toEqual(1);
      done();
    });
  })
});

test('/now no result', (done) => {
  return loadBadTest().then(async () => {
    await api.testTextReceived('/now');
    expect(sendMessages[0].message).toEqual("No matching terms in 'pizza'");
    expect(sendMessages.length).toEqual(1);
    done();
  })
});

test('/now page error', (done) => {
  return loadFetchError().then(async () => {
    await api.testTextReceived('/now');
    expect(sendMessages[0].message).toEqual("Fetch error: 404");
    expect(sendMessages.length).toEqual(1);
    done();
  })
});

test('/status', (done) => {
  return loadGoodTest().then(async () => {
    await api.testTextReceived('/status');
    const regex=/Last check at (.*)\nLast difference at (.*)\nCurrent interval: 15 minutes/
    expect(regex.test(sendMessages[0].message)).toBeTruthy();
    expect(sendMessages.length).toEqual(1);
    done();
  })
});

test('/list', (done) => {
  return loadGoodTest().then(async () => {
    await api.testTextReceived('/list');
    const regex=/cabernet/
    expect(regex.test(sendMessages[0].message)).toBeTruthy();
    expect(sendMessages.length).toEqual(1);
    done();
  })
});

test('/list default', (done) => {
  return loadGoodTest().then(async () => {
    // first add something
    const regex=/pizza/
    await api.testTextReceived("/add pizza");
    expect(regex.test(sendMessages[0].message)).toBeTruthy();
    sendMessages = [];
    await api.testTextReceived("/list");
    expect(regex.test(sendMessages[0].message)).toBeTruthy();
    sendMessages = [];
    await api.testTextReceived('/list default');
    expect(regex.test(sendMessages[0].message)).toBeFalsy();
    done();
  })
});

test('/uptick 3', (done) => {
  return loadGoodTest().then(async () => {
    await api.testTextReceived('/uptick 3');
    const regex=/Check interval changed to 3 minutes/
    expect(regex.test(sendMessages[0].message)).toBeTruthy();
    // expect(sendMessages.length).toEqual(2);
    done();
  })
});

test('/uptick 1d', (done) => {
  return loadGoodTest().then(async () => {
    await api.testTextReceived('/uptick 1d');
    const regex=/Check interval changed to a day/
    expect(regex.test(sendMessages[0].message)).toBeTruthy();
    // expect(sendMessages.length).toEqual(2);
    done();
  })
});

test('/uptick default', (done) => {
  return loadGoodTest().then(async () => {
    await api.testTextReceived('/uptick default');
    const regex=/Check interval changed to 15 minutes/
    expect(regex.test(sendMessages[0].message)).toBeTruthy();
    // expect(sendMessages.length).toEqual(2);
    done();
  })
});

test('/uptick nothing', (done) => {
  return loadGoodTest().then(async () => {
    await api.testTextReceived('/uptick nothing');
    const regex=/nothing is not a valid number/
    expect(regex.test(sendMessages[0].message)).toBeTruthy();
    // expect(sendMessages.length).toEqual(1);
    done();
  })
});

test('/start', (done) => {
  return loadGoodTest().then(async () => {
    await api.testTextReceived('/start');
    const regex=/Your chat id is chatid/
    expect(regex.test(sendMessages[0].message)).toBeTruthy();
    expect(sendMessages.length).toEqual(1);
    done();
  })
});

test('/add pizza', (done) => {
  return loadGoodTest().then(async () => {
    await api.testTextReceived('/add pizza');
    const regex=/pizza/
    expect(regex.test(sendMessages[0].message)).toBeTruthy();
    expect(sendMessages.length).toEqual(2);
    expect(/Found a match/.test(sendMessages[1].message)).toBeTruthy();
    done();
  })
});

test('/add cabernet', (done) => {
  return loadGoodTest().then(async () => {
    await api.testTextReceived('/add cabernet');
    const regex=/already a search term/
    expect(regex.test(sendMessages[0].message)).toBeTruthy();
    expect(sendMessages.length).toEqual(1);
    done();
  })
});

test('/del cabernet', (done) => {
  return loadGoodTest().then(async () => {
    await api.testTextReceived('/del cabernet');
    const regex=/cabernet/
    expect(regex.test(sendMessages[0].message)).toBeFalsy();
    expect(sendMessages.length).toEqual(2);
    done();
  })
});

test('/del pizza', (done) => {
  return loadGoodTest().then(async () => {
    await api.testTextReceived('/del pizza');
    const regex=/is not a search term/
    expect(regex.test(sendMessages[0].message)).toBeTruthy();
    expect(sendMessages.length).toEqual(1);
    done();
  })
});