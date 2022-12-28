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
    getAsync: null,
    numSetIntCalls: 0,
    numClrIntCalls: 0,

    reset: () => {
        TestUtils.sendMessages = [];
        if (TestUtils.redisClient) {
            TestUtils.redisClient.flushall();
        }
        TestUtils.intID = 0;
        TestUtils.callbacks = [];
        TestUtils.numSetIntCalls = 0;
        TestUtils.numClrIntCalls = 0;
    },

    logCapture: (msg) => {
        // console.log(expect.getState().currentTestName + ": " + msg);
        // don't spit out watcher messages
    },

    realLogger: (msg) => {
      // console.log(expect.getState().currentTestName + ": " + msg);
    },

    logTestName: (msg) => {
     // console.log(expect.getState().currentTestName + ": " + msg);
    },

    // overloads for set/clearInterval
    intID: 0,
    intCount: -1,
    testID: '',
    callbacks: [],
    setIntFunc: (fn, count) => {
        TestUtils.numSetIntCalls++;
        TestUtils.testID = expect.getState().currentTestName;
        TestUtils.intID++;
        TestUtils.callbacks.push({lastActive: Date.now(), callback: fn, interval: count, id: TestUtils.intID });
        return TestUtils.intID;
    },

    setTimeoutFunc: (fn, count) => {
        TestUtils.testID = expect.getState().currentTestName;
        TestUtils.intID++;
        TestUtils.callbacks.push({lastActive: Date.now(), callback: fn, interval: count, id: TestUtils.intID, oneshot: true });
        return TestUtils.intID;
    },

    clrIntFunc: (id) => {
        TestUtils.logTestName("clearInteval)");
        TestUtils.numClrIntCalls++;
        var toDel = -1;
	    for (var i = 0; i < TestUtils.callbacks.length; i++) {
		    if (TestUtils.callbacks[i].id == id) {
			    toDel = i;
    			break;
	    	}
        }
        expect(toDel).not.toEqual(-1);
        TestUtils.callbacks.splice(toDel, 1);
        return;
    },

    advanceClock: async (val) => {
    	// find the next timeout that will activate during the advance
        var newDate = (Object.prototype.toString.call(val) === '[object Date]') ? 
                        val : Date.now() + val;

        if (TestUtils.callbacks.length == 0) { 
            return;
        }

        while (Date.now() < newDate) {
            // find things to activate
            // create an array sorted by the next thing to activate
            var sorted = [];
            const now = Date.now();
            for (var i = 0; i < TestUtils.callbacks.length; i++) {
                sorted.push({ nextActive: TestUtils.callbacks[i].lastActive + TestUtils.callbacks[i].interval - now, index: i });
            }
            sorted.sort( (a,b) => { return (a.nextActive - b.nextActive); });
            // just advance the time if nothing will activate
            if (sorted[0].nextActive + now > newDate) {
                MockDate.set(newDate);
                return;
            }   
            // activate everything set for sorted[0]'s time
            MockDate.set(sorted[0].nextActive + now);
            var i = 0;
            var toRemove = [];
            while (i < sorted.length && sorted[i].nextActive == sorted[0].nextActive) {
                await TestUtils.callbacks[sorted[i].index].callback();
                if (!!TestUtils.callbacks[sorted[i].index].oneshot) {
                    toRemove.push(sorted[i].index);
                } else {
                    TestUtils.callbacks[sorted[i].index].lastActive = Date.now();
                }
                i++;
            }
            // remove one shot timeouts from last to first
            for (var i = toRemove.length - 1; i >= 0; i--) {
                TestUtils.callbacks.splice(i, 1);
            }
        }
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
        TestUtils.getAsync = promisify(TestUtils.redisClient.get).bind(TestUtils.redisClient);
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
