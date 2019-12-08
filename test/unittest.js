const tgramShim = require('./tgramShim');
const redis = require("redis");
const { promisify } = require('util');
const durationParser = require('parse-duration');
const events = require('events');

// determine redis host from environment and connect
const opts = { host: process.env.REDIS_HOST || "localhost", port: process.env.REDIS_PORT || 6379,  };

const client = redis.createClient(opts);

module.exports = {
  setUp: function (cb) {
    this._openStdin = process.openStdin;
    this._log = console.log;
    // ... other setup tasks, like api and redis
    client.select(9); // 9 is the test DB in redis
    this.api = new tgramShim();
    this.client = client;
    this.watchRuntime = new watchRuntime(api, client);
    this._exit = process.exit;
    var ev = this.ev = new events.EventEmitter();
    process.openStdin = function () { return ev; };
    // remove all keys
    return this.client.flushdb( (err, success) => { return cb(); });
  },
  tearDown: function (cb) {
    // reset all the overidden functions:
    process.openStdin = this._openStdin;
    process.exit = this._exit;
    // ... other tearDown tasks
    console.log = this._log;
    // remove all keys
    return this.client.flushdb( (err, success) => { return cb(); });
  },
  'test something': function(test) {
    test.equal(1, 1);
    test.done();
  }
};
