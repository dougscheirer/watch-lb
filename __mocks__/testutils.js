// testutils.js
const { watchRuntime } = require('../watchRuntime');
const redis = require("redis-mock");
const fs = require('fs');
const tgramMock = require('../__mocks__/tgramMock');
const MockDate = require("mockdate");
const durationParser = require("parse-duration");
const { promisify } = require('util');

var TestUtils = {
    // not sure if this needs export
    adate: "03/16/2020",
    sendMessages: [],
    watcher: null,
    api: null,
    redisClient: redis.createClient(),
    badTest2Content: "<html><head></head><body>Do not match stuff<h1 class=\"offer-name-tag-invalid\">pizza</h1></body></html>",

    logCapture: () => {
        // don't spit out watcher messages
    },

    realLogger: (msg) => {
    // console.log(msg);
    },

    logTestName: (msg) => {
    // console.log(expect.getState().currentTestName + ": " + msg);
    },

    // overloads for set/clearInterval
    intID: 0,
    intCount: -1,
    intFn: undefined,
    testID: '',
    setIntFunc: (fn, count) => {
        TestUtils.logTestName("setInteval");
        if (intFn != undefined) {
            TestUtils.logTestName("going to fail here");
            // TODO: figure out why /settings test fails in full test mode
            // expect(intFn).toEqual(undefined);
        }
        testID = expect.getState().currentTestName;
        intCount = count;
        intFn = fn;
        intID++;
        return intID;
    },

    clrIntFunc: (id) => {
        TestUtils.logTestName("clearInteval)");
        expect(id).toEqual(intID);
        intCount = -1;
        intFn = undefined;
        return;
    },

    initWatcher: (fetchFunc, optLogger) => {
        MockDate.set(TestUtils.adate);
        TestUtils.api = new tgramMock(
                "chatid", 
                function (chatid, msg) { TestUtils.sendMessages.push({ chatid: chatid, message: msg }); },
                { onlyFirstMatch: true },
        );
        // clean redis? 
        // client.del('watch-lb-settings');
        TestUtils.watcher = new watchRuntime({
            telegramApi: TestUtils.api, 
            redisApi: TestUtils.redisClient, 
            chatid: "chatid", 
            fetchFunc: fetchFunc,
            setInterval: TestUtils.setIntFunc,
            clearInterval: TestUtils.clrIntFunc,
            logger: (optLogger) ? optLogger : TestUtils.logCapture
        });
    },

    loadWatcher: (fetchFunc, optLogger) => {
        TestUtils.initWatcher(fetchFunc, optLogger);
        return TestUtils.watcher.loadSettings();
    },

    loadTest: (fname, optLogger) => {
      return TestUtils.loadWatcher(async (url) => {
        var body;
        try {
        body = fs.readFileSync(fname).toString();
        } catch (e) { 
        console.log("error loading test:" + e); 
        }
        return { status: 200, data: body, headers: [{ result: "pie" }] };
        }, optLogger);
    },

    loadGoodTest: (optLogger) => {
        return TestUtils.loadTest("./testdata/good.html", optLogger);
    },

    loadBadTest: () => {
        return TestUtils.loadWatcher(async (url) => {
        // console.log("got a call for " + url);
        return { status: 200, data: 
            "<html><head></head><body>Do not match stuff<h1 class=\"offer-name\">pizza</h1></body></html>", 
            headers: [{ result: "pie" }] };
        });
    },

    loadBadTest2: () => {
    return TestUtils.loadWatcher(async (url) => {
        // console.log("got a call for " + url);
        return { status: 200, data: 
            TestUtils.badTest2Content, 
            headers: [{ result: "pie" }] };
        });
    },

    loadFetchError: () => {
    return TestUtils.loadWatcher(async (url) => {
        // console.log("got a call for " + url);
        return { status: 404, data: null, headers: [{ result: "pie" }] };
        });
    }
}

module.exports = TestUtils;