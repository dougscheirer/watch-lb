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
const tu = require('../__mocks__/testutils');

// for use elsewhere
const posMatch =  "Found a match for cabernet ($89) in Groth Oakville Cabernet Sauvignon Reserve 2015\nhttps://lastbottlewines.com";
const baseCheckRegex = "Last check at (.*)\nLast difference at (.*)\nLast offer: \\(LB8212\\) Groth Oakville Cabernet Sauvignon Reserve 2015 \\$89\nLast MD5: (.*)\nCurrent interval: 15 minutes\n";
const serviceRegex = "Service uptime: (.*)\n"
const badTest2Content = "<html><head></head><body>Do not match stuff<h1 class=\"offer-name-tag-invalid\">pizza</h1></body></html>";
const recentRegex = 'offer-match-([0-9]+): {"name":"Groth Oakville Cabernet Sauvignon Reserve 2015","price":"89","link":"https://www.lastbottlewines.com/cart/add/LB8212.html","id":"LB8212","md5":"1e5efef7c1494301ead78139cd413143"}';

beforeEach(() => {
  if (tu.redisClient) {
    tu.redisClient.flushall();
  }
  tu.logTestName("beforeEach");
  tu.sendMessages = [];
  intID = 0;
  intCount = -1;
  intFn = undefined;
  testID = '';
});

afterEach(() => {
  // console.log("SENT MESSAGES: ");
  // console.log(tu.sendMessages);
  tu.sendMessages = [];
  watcher = null;
});

/***************************************************************************************
 * 
 * Begin tests
 * 
 ***************************************************************************************/

test('sendMessage', (done) => {
  return tu.loadGoodTest().then(() => {
    tu.watcher.sendMessage("this is a pizza");
    expect(tu.sendMessages[0].message).toEqual("this is a pizza");
    expect(tu.sendMessages.length).toEqual(1);
    done();
  });
});


test('/now positive result', (done) => {
  return tu.loadGoodTest().then(() => {
    tu.api.testTextReceived('/now').then((res) => {
      expect(tu.sendMessages[0].message).toEqual(posMatch);
      expect(tu.sendMessages.length).toEqual(1);
      done();
    });
  });
});

test('/now no result', (done) => {
  return tu.loadBadTest().then(async () => {
    await tu.api.testTextReceived('/now');
    expect(tu.sendMessages[0].message).toEqual("No matching terms in 'pizza'");
    expect(tu.sendMessages.length).toEqual(1);
    done();
  });
});

test('/now bad parse', (done) => {
  const getAsync = promisify(tu.redisClient.get).bind(tu.redisClient);

  return tu.loadBadTest2().then(async () => {
    await tu.api.testTextReceived('/now');
    const regex = new RegExp("offer-name class not found, perhaps the page formatting has changed or there was a page load error: offer-invalid-(.*)");
    expect(regex.test(tu.sendMessages[0].message)).toBeTruthy();
    expect(tu.sendMessages.length).toEqual(1);
    // expect a new redis value of 'offer-invalid-YYYYMMDDHHMMSS' with the bad test data
    rx=/offer-invalid-(.*)/g;
    const match = rx.exec(tu.sendMessages[0].message);
    const dump = await getAsync(match[0]);
    expect(dump).toEqual(badTest2Content);
    done();
  });
});

test('/now bad parse + /lserror', (done) => {
  const getAsync = promisify(tu.redisClient.get).bind(tu.redisClient);

  return tu.loadBadTest2().then(async () => {
    await tu.api.testTextReceived('/now');
    tu.sendMessages = [];
    await tu.api.testTextReceived('/lserror');
    rx=/offer-invalid-(.*)/g;
    const match = rx.exec(tu.sendMessages[0].message);
    expect(match.length).toEqual(2);
    done();
  });
});

test('/now bad parse + /showerror', (done) => {
  const getAsync = promisify(tu.redisClient.get).bind(tu.redisClient);

  return tu.loadBadTest2().then(async () => {
    await tu.api.testTextReceived('/now');
    // expect a new redis value of 'offer-invalid-YYYYMMDDHHMMSS' with the bad test data
    rx=/offer-invalid-(.*)/g;
    const match = rx.exec(tu.sendMessages[0].message);
    tu.sendMessages = [];
    await tu.api.testTextReceived('/showerror ' + match[0]);
    expect("Error " + match[0] + "\n" + badTest2Content).toEqual(tu.sendMessages[0].message);
    done();
  });
});

test('/now bad parse + /clrerror N', (done) => {
  const getAsync = promisify(tu.redisClient.get).bind(tu.redisClient);
  return tu.loadBadTest2().then(async () => {
    await tu.api.testTextReceived('/now');
    // expect a new redis value of 'offer-invalid-YYYYMMDDHHMMSS' with the bad test data
    rx=/offer-invalid-(.*)/g;
    const match = rx.exec(tu.sendMessages[0].message);
    tu.sendMessages = [];
    await tu.api.testTextReceived('/clrerror ' + match[0]);
    expect("Cleared " + match[0]).toEqual(tu.sendMessages[0].message);
    // also fetch the value expect that it is not there
    const val = await getAsync(match[0]);
    expect(val).toBeFalsy();
    done();
  });
});

test('/now bad parse + /clrerror', (done) => {
  const getAsync = promisify(tu.redisClient.get).bind(tu.redisClient);
  return tu.loadBadTest2().then(async () => {
    await tu.api.testTextReceived('/now');
    // expect a new redis value of 'offer-invalid-YYYYMMDDHHMMSS' with the bad test data
    rx=/offer-invalid-(.*)/g;
    const match = rx.exec(tu.sendMessages[0].message);
    tu.sendMessages = [];
    await tu.api.testTextReceived('/clrerror');
    expect("Cleared all offer invalid keys").toEqual(tu.sendMessages[0].message);
    // also fetch the value expect that it is not there
    const val = await getAsync(match[0]);
    expect(val).toBeFalsy();
    done();
  });
});


test('/now near-duplicate no result', (done) => {
  return tu.loadGoodTest().then(async () => {
    await tu.watcher.checkWines();
    // should have a match message
    expect(tu.sendMessages[0].message).toEqual(posMatch);
    // modify the MD5 but leave the content the same
    tu.watcher.savedSettings.lastMD5 = "";
    await tu.watcher.checkWines();
    // should get no message
    expect(tu.sendMessages.length).toEqual(1);
    done();
  });
});

test('/now page error', (done) => {
  return tu.loadFetchError().then(async () => {
    await tu.api.testTextReceived('/now');
    expect(tu.sendMessages[0].message).toEqual("Fetch error: 404");
    expect(tu.sendMessages.length).toEqual(1);
    done();
  });
});

test('/status', (done) => {
  return tu.loadGoodTest().then(async () => {
    await tu.watcher.checkWines();
    tu.sendMessages=[];
    await tu.api.testTextReceived('/status');
    const regex = new RegExp(baseCheckRegex + serviceRegex + "git: (.*)");
    // console.log(tu.sendMessages[0].message);
    expect(regex.test(tu.sendMessages[0].message)).toBeTruthy();
    expect(tu.sendMessages.length).toEqual(1);
    done();
  });
});

test('/status with 0 start time', (done) => {
  return tu.loadGoodTest().then(async () => {
    await tu.watcher.checkWines();
    tu.watcher.runtimeSettings.startTime = new Date();
    tu.sendMessages=[];
    await tu.api.testTextReceived('/status');
    const regex = new RegExp(baseCheckRegex + "Service uptime: a few seconds\ngit: (.*)");
    expect(regex.test(tu.sendMessages[0].message)).toBeTruthy();
    expect(tu.sendMessages.length).toEqual(1);
    done();
  });
});

test('/status with 5m start time', (done) => {
  return tu.loadGoodTest().then(async () => {
    await tu.watcher.checkWines();
    tu.watcher.runtimeSettings.startTime = new Date(new Date() - 5*60*1000);
    tu.sendMessages=[];
    await tu.api.testTextReceived('/status');
    const regex = new RegExp(baseCheckRegex + "Service uptime: 5 minutes\ngit: (.*)");
    expect(regex.test(tu.sendMessages[0].message)).toBeTruthy();
    expect(tu.sendMessages.length).toEqual(1);
    done();
  });
});

test('/status paused forever', (done) => {
  return tu.loadGoodTest().then(async () => {
    await tu.watcher.checkWines();
    await tu.api.testTextReceived('/pause');
    tu.sendMessages=[];
    await tu.api.testTextReceived('/status');
    const regex = new RegExp(baseCheckRegex + "Service uptime: (.*)\nPaused until forever");
    expect(regex.test(tu.sendMessages[0].message)).toBeTruthy();
    expect(tu.sendMessages.length).toEqual(1);
    done();
  });
});

test('/status paused for a while', (done) => {
  return tu.loadGoodTest().then(async () => {
    await tu.watcher.checkWines();
    await tu.api.testTextReceived('/pause 15d');
    tu.sendMessages=[];
    await tu.api.testTextReceived('/status');
    const regex = new RegExp(baseCheckRegex + "Service uptime: (.*)\nPaused until ");
    expect(regex.test(tu.sendMessages[0].message)).toBeTruthy();
    expect(tu.sendMessages.length).toEqual(1);
    done();
  });
});

test('/list', (done) => {
  return tu.loadGoodTest().then(async () => {
    await tu.api.testTextReceived('/list');
    const regex=/cabernet/;
    expect(regex.test(tu.sendMessages[0].message)).toBeTruthy();
    expect(tu.sendMessages.length).toEqual(1);
    done();
  });
});

test('/list default', (done) => {
  return tu.loadGoodTest().then(async () => {
    // first add something
    const regex=/pizza/;
    await tu.api.testTextReceived("/add pizza");
    expect(regex.test(tu.sendMessages[0].message)).toBeTruthy();
    tu.sendMessages = [];
    await tu.api.testTextReceived("/list");
    expect(regex.test(tu.sendMessages[0].message)).toBeTruthy();
    tu.sendMessages = [];
    await tu.api.testTextReceived('/list default');
    expect(regex.test(tu.sendMessages[0].message)).toBeFalsy();
    done();
  });
});

test('/uptick 3', (done) => {
  return tu.loadGoodTest().then(async () => {
    await tu.api.testTextReceived('/uptick 3');
    const regex=/Check interval changed to 3 minutes/;
    // first message is match message from checkWines
    expect(tu.sendMessages.length).toEqual(2);
    expect(regex.test(tu.sendMessages[1].message)).toBeTruthy();
    done();
  });
});

test('/uptick 1d', (done) => {
  return tu.loadGoodTest().then(async () => {
    await tu.api.testTextReceived('/uptick 1d');
    const regex=/Check interval changed to a day/;
    // first message is match message from checkWines
    expect(tu.sendMessages.length).toEqual(2);
    expect(regex.test(tu.sendMessages[1].message)).toBeTruthy();
    done();
  });
});

test('/uptick default', (done) => {
  return tu.loadGoodTest().then(async () => {
    await tu.api.testTextReceived('/uptick default');
    const regex=/Check interval changed to 15 minutes/;
    // first message is match message from checkWines
    expect(tu.sendMessages.length).toEqual(2);
    expect(regex.test(tu.sendMessages[1].message)).toBeTruthy();
    done();
  });
});

test('/uptick nothing', (done) => {
  return tu.loadGoodTest().then(async () => {
    await tu.api.testTextReceived('/uptick nothing');
    const regex=/nothing is not a valid number/;
    expect(regex.test(tu.sendMessages[0].message)).toBeTruthy();
    // expect(tu.sendMessages.length).toEqual(1);
    done();
  });
});

test('/start', (done) => {
  return tu.loadGoodTest().then(async () => {
    await tu.api.testTextReceived('/start');
    const regex=/Your chat id is chatid/;
    expect(regex.test(tu.sendMessages[0].message)).toBeTruthy();
    expect(tu.sendMessages.length).toEqual(1);
    done();
  });
});

test('/add pizza', (done) => {
  return tu.loadGoodTest().then(async () => {
    await tu.api.testTextReceived('/add pizza');
    const regex=/pizza/;
    expect(regex.test(tu.sendMessages[0].message)).toBeTruthy();
    expect(tu.sendMessages.length).toEqual(2);
    expect(/Found a match/.test(tu.sendMessages[1].message)).toBeTruthy();
    done();
  });
});

test('/add cabernet', (done) => {
  return tu.loadGoodTest().then(async () => {
    await tu.api.testTextReceived('/add cabernet');
    const regex=/already a search term/;
    expect(regex.test(tu.sendMessages[0].message)).toBeTruthy();
    expect(tu.sendMessages.length).toEqual(1);
    done();
  });
});

test('/del cabernet', (done) => {
  return tu.loadGoodTest().then(async () => {
    await tu.api.testTextReceived('/del cabernet');
    const regex=/cabernet/;
    expect(regex.test(tu.sendMessages[0].message)).toBeFalsy();
    expect(tu.sendMessages.length).toEqual(2);
    done();
  });
});

test('/del pizza', (done) => {
  return tu.loadGoodTest().then(async () => {
    await tu.api.testTextReceived('/del pizza');
    const regex=/is not a search term/;
    expect(regex.test(tu.sendMessages[0].message)).toBeTruthy();
    expect(tu.sendMessages.length).toEqual(1);
    done();
  });
});

test('/pause', (done) => {
  return tu.loadGoodTest().then(async () => {
    await tu.api.testTextReceived('/pause');
    const regex=/Pausing until forever/;
    expect(regex.test(tu.sendMessages[0].message)).toBeTruthy();
    expect(tu.sendMessages.length).toEqual(1);
    // make sure it will not check
    tu.sendMessages=[];
    tu.watcher.checkWines(true);
    const regex2=/Paused, use \/resume to restart/;
    expect(regex2.test(tu.sendMessages[0].message)).toBeTruthy();
    expect(tu.sendMessages.length).toEqual(1);
    // resume
    tu.sendMessages=[];
    await tu.api.testTextReceived('/resume');
    const regex3=/Resuming with check interval of/;
    expect(regex3.test(tu.sendMessages[0].message)).toBeTruthy();
    expect(tu.sendMessages.length).toEqual(1);
    done();
  });
});

test('/pause 2 weeks and resume', (done) => {
  return tu.loadGoodTest().then(async () => {
    await tu.api.testTextReceived('/pause 2 weeks');
    const regex=/Pausing until/;
    expect(regex.test(tu.sendMessages[0].message)).toBeTruthy();
    expect(tu.sendMessages.length).toEqual(1);
    // make sure it will not check
    tu.sendMessages=[];
    tu.watcher.checkWines(true);
    const regex2=/Paused, will resume on/;
    expect(regex2.test(tu.sendMessages[0].message)).toBeTruthy();
    expect(tu.sendMessages.length).toEqual(1);
    // resume
    tu.sendMessages=[];
    await tu.api.testTextReceived('/resume');
    const regex3=/Resuming with check interval of/;
    expect(regex3.test(tu.sendMessages[0].message)).toBeTruthy();
    expect(tu.sendMessages.length).toEqual(1);
    done();
  });
});

test('/pause 2 weeks', (done) => {
  return tu.loadGoodTest().then(async () => {
    await tu.api.testTextReceived('/pause 2 weeks');
    const regex=/Pausing until/;
    expect(regex.test(tu.sendMessages[0].message)).toBeTruthy();
    expect(tu.sendMessages.length).toEqual(1);
    // make sure it will not check
    tu.sendMessages=[];
    await tu.watcher.checkWines(true);
    const regex2=/Paused, will resume on/;
    expect(regex2.test(tu.sendMessages[0].message)).toBeTruthy();
    expect(tu.sendMessages.length).toEqual(1);
    // advance clock >2 weeks
    MockDate.set(new Date(adate).getTime() + durationParser("2 weeks") + durationParser("1 minute"));
    tu.sendMessages=[];
    await tu.watcher.checkWines(true);
    expect(tu.sendMessages[0].message).toEqual(posMatch);
    expect(tu.sendMessages.length).toEqual(1);
    done();
  });
});

test('/pause 1 day with datestamp', (done) => {
  return tu.loadGoodTest().then(async () => {
    const now = new Date();
    const dateString = (now.getMonth()+1) + '/' + (now.getDate()+1) + '/' + now.getFullYear();
    await tu.api.testTextReceived('/pause ' + dateString);
    const regex=/Pausing until/;
    expect(regex.test(tu.sendMessages[0].message)).toBeTruthy();
    expect(tu.sendMessages.length).toEqual(1);
    // make sure it will not check
    tu.sendMessages=[];
    await tu.watcher.checkWines(true);
    const regex2=/Paused, will resume on/;
    expect(regex2.test(tu.sendMessages[0].message)).toBeTruthy();
    expect(tu.sendMessages.length).toEqual(1);
    // advance clock >1 day
    MockDate.set(new Date(adate).getTime() + durationParser("1 day") + durationParser("1 minute"));
    tu.sendMessages=[];
    await tu.watcher.checkWines(true);
    expect(tu.sendMessages[0].message).toEqual(posMatch);
    expect(tu.sendMessages.length).toEqual(1);
    done();
  });
});

test('/pause 1 hour with timestamp', (done) => {
  return tu.loadGoodTest().then(async () => {
    const now = new Date();
    const dateString = (now.getMonth()+1) + '/' + (now.getDate()+1) + '/' + now.getFullYear();
    await tu.api.testTextReceived('/pause ' + dateString);
    const regex=/Pausing until/;
    expect(regex.test(tu.sendMessages[0].message)).toBeTruthy();
    expect(tu.sendMessages.length).toEqual(1);
    // make sure it will not check
    tu.sendMessages=[];
    await tu.watcher.checkWines(true);
    const regex2=/Paused, will resume on/;
    expect(regex2.test(tu.sendMessages[0].message)).toBeTruthy();
    expect(tu.sendMessages.length).toEqual(1);
    // advance clock >1 day
    MockDate.set(new Date(adate).getTime() + durationParser("1 day") + durationParser("1 minute"));
    tu.sendMessages=[];
    await tu.watcher.checkWines(true);
    expect(tu.sendMessages[0].message).toEqual(posMatch);
    expect(tu.sendMessages.length).toEqual(1);
    done();
  });
});

test('/pause with unparsable', (done) => {
  return tu.loadGoodTest().then(async () => {
    const now = new Date();
    const dateString = " no idea";
    await tu.api.testTextReceived('/pause ' + dateString);
    const regex=new RegExp('Unrecognized pause argument');
    expect(regex.test(tu.sendMessages[0].message)).toBeTruthy();
    expect(tu.sendMessages.length).toEqual(1);
    // make sure it will still check
    tu.sendMessages=[];
    await tu.watcher.checkWines(true);
    expect(tu.sendMessages[0].message).toEqual(posMatch);
    expect(tu.sendMessages.length).toEqual(1);
    done();
  });
});

test('/pause and reload', (done) => {
  return tu.loadGoodTest().then(async () => {
    await tu.api.testTextReceived('/pause 2 weeks');
    const regex=/Pausing until/;
    expect(regex.test(tu.sendMessages[0].message)).toBeTruthy();
    expect(tu.sendMessages.length).toEqual(1);
    // make sure it will not check
    tu.sendMessages=[];
    tu.watcher.checkWines(true);
    const regex2=/Paused, will resume on/;
    expect(regex2.test(tu.sendMessages[0].message)).toBeTruthy();
    expect(tu.sendMessages.length).toEqual(1);
    // reload
    tu.watcher.loadSettings(false);
    tu.sendMessages=[];
    tu.watcher.checkWines(true);
    tu.sendMessages=[];
    await tu.api.testTextReceived('/status');
    const regex3=/Never checked\nCurrent interval: 15 minutes\nService uptime: (.*)\nPaused until /;
    expect(regex3.test(tu.sendMessages[0].message)).toBeTruthy();
    expect(tu.sendMessages[0].message.includes("forever") == false).toBeTruthy();
    expect(tu.sendMessages.length).toEqual(1);
    done();
  });
});

test('/settings', (done) => {
  return tu.loadGoodTest(realLogger).then(async () => {
    await tu.api.testTextReceived('/settings');
    expect(tu.sendMessages.length).toEqual(1);
    var settingsJson = null;
    try {
      settingsJson = JSON.parse(tu.sendMessages[0].message);
    } catch (e) {
      expect(e).toBeFalsy(); // we failed
    }
    done();
  });
});

test('/badcmd', (done) => {
  return tu.loadGoodTest().then(async () => {
    await tu.api.testTextReceived('/badcmd');
    expect(tu.sendMessages.length).toEqual(1);
    expect(tu.sendMessages[0].message).toEqual("Unknown command");
    done();
  });
});

test('updated page test', (done) => {
  return tu.loadTest("./testdata/updated-purchase.html").then(async () => {
    await tu.watcher.checkWines();
    tu.sendMessages=[];
    await tu.api.testTextReceived('/status');
    const regex = /Last check at (.*)\nLast difference at (.*)\nLast offer: \(LB3FAARE\) Beau Vigne Old Rutherford Cabernet Sauvignon Napa Valley 2019 \$49\nLast MD5: (.*)\nCurrent interval: 15 minutes\nService uptime: (.*)\n/;
    // console.log(tu.sendMessages[0].message);
    expect(regex.test(tu.sendMessages[0].message)).toBeTruthy();
    expect(tu.sendMessages.length).toEqual(1);
    done();
  });
});
 
test('test with actual web fetch', (done) => {
  tu.initWatcher();
  return tu.watcher.loadSettings(false).then(async () => {
    try {
      await tu.watcher.checkWines(true);
      expect(tu.sendMessages.length).toEqual(1);
      // console.log(tu.sendMessages);
    } catch (e) {
      console.log(e);
    }
    done();
  })
});

async function saveFakeMatches() {
  for (var i = 0; i < 30; i++) {
    await tu.watcher.setAsync('offer-match-20200315000' + (100+i), "this is a fake match " + i);
  }
}
test('/recent', (done) => {
  return tu.loadGoodTest().then(() => {
    tu.api.testTextReceived('/now').then(async (res) => {
      tu.sendMessages=[];
      await saveFakeMatches();
      tu.api.testTextReceived('/recent').then((res) => {
        expect(tu.sendMessages.length).toEqual(1);
        expect((new RegExp(recentRegex)).exec(tu.sendMessages[0].message).length).toEqual(2);
        expect(tu.sendMessages[0].message.split("\n").length).toEqual(11);
        done();
      })
    })
  })
});

test('/recent 3', (done) => {
  return tu.loadGoodTest().then(() => {
    tu.api.testTextReceived('/now').then(async (res) => {
      tu.sendMessages=[];
      await saveFakeMatches();
      tu.api.testTextReceived('/recent 3').then((res) => {
        expect(tu.sendMessages.length).toEqual(1);
        expect(tu.sendMessages[0].message.split("\n").length).toEqual(4);
        done();
      })
    })
  })
});

test('/recent notnum', (done) => {
  return tu.loadGoodTest().then(() => {
    tu.api.testTextReceived('/now').then((res) => {
      tu.sendMessages=[];
      tu.api.testTextReceived('/recent notnum').then((res) => {
        expect(tu.sendMessages.length).toEqual(1);
        expect(tu.sendMessages[0].message).toEqual("notnum is not a valid number.  Specify a number of offers to fetch");
        done();
      })
    })
  })
});
