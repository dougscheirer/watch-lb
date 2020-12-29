async function pA(d) {
  if (d > 5) {
    return Promise.reject("too big");
  }

  return "from pA: " + d;
}

async function pB(d) {
  return "from pB: " + d;
}

pA(2).then((d) => { return pB(d); } ).then((d) => { return "from inline " + d; }).then((d) => console.log(d));
  pA(6).then((d) => { return pB(d); } ).then((d) => { return "from inline2" + d; }).then((d) => console.log(d)).catch( (e) => {
  console.log("caught: " + e);
});

function multiRet() {
  return { one: 1, two: 2};
}

var r = multiRet();
console.log(r.one);
console.log(r.two);