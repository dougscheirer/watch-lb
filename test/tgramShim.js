// return a thing that looks like the telegram API, but just pretends
function tgramShim() {
  this.onText = (regexp, fn) => {
    console.log('add regexp ' + regexp);
    console.log('with function ' + fn);
    // probably provide some way of invoking fn as if onText matched something?
  },
  this.testTextReceived = (text) => {
    // find one of our regexps and match it?
    console.log("TODO: match a thing");
  }
}

module.exports = tgramShim;