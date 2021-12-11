// init from default, make sure it's saved
const { watchRuntime } = require('../watchRuntime');
const redis = require("redis-mock");
const fs = require('fs');
const tgramMock = require('../__mocks__/tgramMock');
const { promisify } = require('util');

var sendMessages = [];
var watcher = null;
var api = null;
var client = null;
var getAsync = null;

function logCapture() {
  // don't spit out watcher messages
}

function initWatcher() {
  api = new tgramMock(
    "chatid", 
    function (chatid, msg) { sendMessages.push({ chatid: chatid, message: msg }); },
    { onlyFirstMatch: true });
  client = redis.createClient();
  getAsync = promisify(client.get).bind(client),
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

test('default settings save', (done) => {
  return loadGoodTest().then(async () => {
    // verify that redis has the data
    var settings = await getAsync('watch-lb-settings');
    const settingObject = JSON.parse(settings);
    expect(settingObject.matching).not.toBe(null);
    expect(settingObject.matching.length).toBeGreaterThan(5);
    expect(settingObject.defaultRate).toBe(15);
    done();
  })
});

test('reloading works', async (done) => {
  var localClient = redis.createClient();
  localClient.set("watch-lb-settings", JSON.stringify({ defaultRate: 1000 }));
  await loadGoodTest();
  // verify that redis has the data
  var settings = await getAsync('watch-lb-settings');
  const settingObject = JSON.parse(settings);
  expect(settingObject.defaultRate).toBe(1000);
  done();
});

test('changing uptick saves', (done) => {
  return loadGoodTest().then(async () => {
    await api.testTextReceived('/uptick 1h');
    // verify that redis has the data
    var settings = await getAsync('watch-lb-settings');
    const settingObject = JSON.parse(settings);
    expect(settingObject.defaultRate).toBe(60);
    done();
  })
});

test('changing pause saves', (done) => {
  return loadGoodTest().then(async () => {
    await api.testTextReceived('/pause');
    // verify that redis has the data
    var settings = await getAsync('watch-lb-settings');
    var settingObject = JSON.parse(settings);
    expect(settingObject.pauseUntil).toBe(0);
    await api.testTextReceived('/resume');
    var settings = await getAsync('watch-lb-settings');
    var settingObject = JSON.parse(settings);
    expect(settingObject.pauseUntil).toBe(-1);    
    done();
  })
});

test('changing pause saves correcly', (done) => {
  return loadGoodTest().then(async () => {
    await api.testTextReceived('/pause 5s');
    // verify that redis has the data
    var settings = await getAsync('watch-lb-settings');
    var settingObject = JSON.parse(settings);
    var settings2 = await getAsync('watch-lb-settings');
    var settingObject2 = JSON.parse(settings2);
    console.log(settingObject);
    console.log(settingObject2);
    expect(settingObject.pauseUntil).toEqual(settingObject2.pauseUntil);
    done();
  })
});
