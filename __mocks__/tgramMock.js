// return a thing that looks like the telegram API, but just pretends
function tgramMock(chatId, cb) {
  this.regexList = [],  // list of regex matches with functions
  this.sendMsgCallback = cb,
  this.msg = { chat: { id: chatId }},
  this.onText = (regexp, fn) => {
    this.regexList.push({  regex: new RegExp(regexp), callback: fn });
  },
  this.testTextReceived = (text) => {
    // find one of our regexps and match it
    for (i in this.regexList) { 
      if (this.regexList[i].regex.test(text)) {
        this.regexList[i].callback(this.msg, text.match(this.regexList[i].regex));
      }
    }
  },
  this.sendMessage = (chat_id,  msg) => {
    this.sendMsgCallback(chat_id, msg);
  }
}

module.exports = tgramMock;