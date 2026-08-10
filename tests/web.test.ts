import assert from 'node:assert/strict';
import test from 'node:test';

import { transportForConversation } from '../src/web/transport.js';
import { jsonContainer } from '../src/web/json.js';

test('network transport is isolated to the selected conversation', () => {
  const rows = [
    { id: 'alpha-1', conversationId: 'alpha' },
    { id: 'beta-1', conversationId: 'beta' },
    { id: 'utility' },
  ];

  assert.deepEqual(transportForConversation(rows, 'alpha'), [rows[0]]);
  assert.deepEqual(transportForConversation(rows, 'beta'), [rows[1]]);
  assert.deepEqual(transportForConversation(rows, undefined), []);
});

test('JSON body renderer accepts parsed or raw containers and rejects non-JSON text', () => {
  const parsed = { message: 'hello' };
  assert.equal(jsonContainer(parsed), parsed);
  assert.deepEqual(jsonContainer(undefined, '{"items":[1,2]}'), { items: [1, 2] });
  assert.equal(jsonContainer(undefined, 'not json'), undefined);
  assert.equal(jsonContainer('primitive', '"primitive"'), undefined);
});
