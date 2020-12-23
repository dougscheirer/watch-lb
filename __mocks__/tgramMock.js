// return a thing that looks like the telegram API, but just pretends
function tgramMock(chatId, cb, options) {
  this.regexList = [],  // list of regex matches with functions
  this.sendMsgCallback = cb,
  this.msg = { chat: { id: chatId }},
  this.options = options;
  this.onText = (regexp, fn) => {
    this.regexList.push({  regex: new RegExp(regexp), callback: fn });
  },
  this.testTextReceived = async (text) => {
    // copied with modification from telegram.js
    var callList = [];
    this.regexList.some((reg) => {
      const result = reg.regex.exec(text);
      if (!result) {
        return false;
      }
      // reset index so we start at the beginning of the regex each time
      reg.regex.lastIndex = 0;
      callList.push({callback: reg.callback, match: text.match(reg.regex)});
      // returning truthy value exits .some
      return this.options.onlyFirstMatch;
    });
    // now that we know who to call, wait on each one
    for (i in callList) {
      await callList[i].callback(this.msg, callList[i].match);
    }
  },
  this.sendMessage = (chat_id,  msg) => {
    this.sendMsgCallback(chat_id, msg);
  }
}

module.exports = tgramMock;