const { test } = require('node:test');
const assert = require('node:assert/strict');
const { WsHub } = require('../src/wsHub');

function fakeSocket() {
  return { readyState: 1, sent: [], send(msg) { this.sent.push(msg); } };
}

test('broadcast only reaches subscribers of that session', () => {
  const hub = new WsHub();
  const a = fakeSocket();
  const b = fakeSocket();
  hub.subscribe('session-a', a);
  hub.subscribe('session-b', b);

  hub.broadcast('session-a', { type: 'step', step: { index: 0 } });

  assert.equal(a.sent.length, 1);
  assert.deepEqual(JSON.parse(a.sent[0]), { type: 'step', step: { index: 0 } });
  assert.equal(b.sent.length, 0);
});

test('unsubscribe stops further messages', () => {
  const hub = new WsHub();
  const a = fakeSocket();
  hub.subscribe('session-a', a);
  hub.unsubscribe('session-a', a);
  hub.broadcast('session-a', { type: 'step' });
  assert.equal(a.sent.length, 0);
});

test('broadcast skips sockets that are not open', () => {
  const hub = new WsHub();
  const a = fakeSocket();
  a.readyState = 3; // CLOSED
  hub.subscribe('session-a', a);
  hub.broadcast('session-a', { type: 'step' });
  assert.equal(a.sent.length, 0);
});
