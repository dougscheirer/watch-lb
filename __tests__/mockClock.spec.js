/**
 * @jest-environment node
 */

const MockDate = require('mockdate');
const tu = require('../__utils__/testutils');

beforeEach( () => {
    tu.reset();
    MockDate.set(tu.adate);
});

test('test one timer', (done) => {
    var toCount = 0;
    tu.setIntFunc( () => {
        toCount++;
    }, 100);
    tu.advanceClock(500).then(() => {
        expect(toCount).toEqual(5);
        done();
    });
});

test('test two timers on same timeout', (done) => {
    var toCount = [0, 0];
    tu.setIntFunc( () => {
        toCount[0]++;
    }, 100);
    tu.setIntFunc( () => {
        toCount[1]++;
    }, 100);
    tu.advanceClock(500).then(() => {
        expect(toCount[0]).toEqual(5);
        expect(toCount[1]).toEqual(5);
        done();
    });
});

test('test two timers, second is out of range', (done) => {
    var toCount = [0, 0];
    tu.setIntFunc( () => {
        toCount[0]++;
    }, 100);
    tu.setIntFunc( () => {
        toCount[1]++;
    }, 501);
    tu.advanceClock(500).then(() => {
        expect(toCount[0]).toEqual(5);
        expect(toCount[1]).toEqual(0);
        done();
    });
});

test('test two timers, one then the other', (done) => {
    var toCount = [0, 0];
    tu.setIntFunc( () => {
        toCount[0]++;
    }, 100);
    tu.setIntFunc( () => {
        toCount[1]++;
    }, 101);
    tu.advanceClock(150).then(() => {
        expect(toCount[0]).toEqual(1);
        expect(toCount[1]).toEqual(1);
        done();
    });
});

test('test two timers, multiple on first and second', (done) => {
    var toCount = [0, 0];
    tu.setIntFunc( () => {
        toCount[0]++;
    }, 100);
    tu.setIntFunc( () => {
        toCount[1]++;
    }, 150);
    tu.advanceClock(500).then(() => {
        expect(toCount[0]).toEqual(5);
        expect(toCount[1]).toEqual(3);
        done();
    });
});

test('test two timers, cancel the first after one fire', (done) => {
    var toCount = [0, 0];
    const int0 = tu.setIntFunc( () => {
        toCount[0]++;
    }, 100);
    const int1 = tu.setIntFunc( () => {
        toCount[1]++;
    }, 150);
    tu.advanceClock(149).then(() => {
        tu.clrIntFunc(int0);
        tu.advanceClock(351).then(() => {
            expect(toCount[0]).toEqual(1);
            expect(toCount[1]).toEqual(3);
        });
        done();
    });
});

test('test one time with Date advance', (done) => {
    var toCount = 0;
    tu.setIntFunc( () => {
        toCount++;
    }, 100);
    tu.advanceClock(new Date(new Date(tu.adate).getTime() + 5000)).then(() => {
        expect(toCount).toEqual(50);
        done();
    });
});

test('test one timer and one timeout', (done) => {
    var toCount = [0, 0];
    const int0 = tu.setTimeoutFunc( () => {
        toCount[0]++;
    }, 100);
    const int1 = tu.setIntFunc( () => {
        toCount[1]++;
    }, 150);
    tu.advanceClock(500).then(() => {
        expect(toCount[0]).toEqual(1);
        expect(toCount[1]).toEqual(3);
        done();
    });
});

