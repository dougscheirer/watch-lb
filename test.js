
function testFns() {
  this.localData = '1234',
  this.pizza = (args) => { this.localData = args; console.log(this.localData); };
};

exports.testFns = testFns;

