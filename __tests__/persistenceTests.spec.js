// init from default, make sure it's saved
const { watchRuntime } = require('../watchRuntime');
const redis = require("redis-mock");
const fs = require('fs');
const tgramMock = require('../__mocks__/tgramMock');
const { promisify } = require('util');
const tu = require('../__utils__/testutils');

beforeEach(() => {
  tu.reset();
});

afterEach(() => {
});

/***************************************************************************************
 * 
 * Begin tests
 * 
 ***************************************************************************************/

test('default settings save', (done) => {
  return tu.loadGoodTest().then(async () => {
    // verify that redis has the data
    var settings = await tu.getAsync('watch-lb-settings');
    const settingObject = JSON.parse(settings);
    expect(settingObject.matching).not.toBe(null);
    expect(settingObject.matching.length).toBeGreaterThan(5);
    expect(settingObject.defaultRate).toBe(15);
    done();
  })
});


test('reloading works', async (done) => {
  var localClient = tu.redisClient;
  localClient.set("watch-lb-settings", JSON.stringify({ defaultRate: 1000 }));
  await tu.loadGoodTest();
  // verify that redis has the data
  var settings = await tu.getAsync('watch-lb-settings');
  const settingObject = JSON.parse(settings);
  expect(settingObject.defaultRate).toBe(1000);
  done();
});

test('changing uptick saves', (done) => {
  return tu.loadGoodTest().then(async () => {
    await tu.api.testTextReceived('/uptick 1h');
    // verify that redis has the data
    var settings = await tu.getAsync('watch-lb-settings');
    const settingObject = JSON.parse(settings);
    expect(settingObject.defaultRate).toBe(60);
    done();
  });
});

test('loading settings is identical', (done) => {
  return tu.loadGoodTest().then(async () => {
    // ran into this while debugging pause, but it
    // could happen for anything that does not convert
    // back and forth from object -> string -> object
    // in the loading process
    await tu.api.testTextReceived('/pause 5s');
    // clone the set data
    var settingObject = {...tu.watcher.savedSettings};
    // clear our tests for set/clearInterval
    intCount = -1;
    intFn = undefined;
    intID = 0;
    // reload
    await tu.watcher.loadSettings();
    var settingObject2 = tu.watcher.savedSettings;
    for (e in settingObject) {
      // console.log("matching " + e);
      expect(e + " is " + settingObject[e]).toEqual(e + " is " + settingObject2[e]);
    }
    done();
  })
});
