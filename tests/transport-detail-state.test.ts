import assert from 'node:assert/strict';
import test from 'node:test';

import { transportDetailForId } from '../src/web/transport-detail-state.js';

test('a revealed transport detail is hidden synchronously when the active request changes', () => {
  const revealed = {
    transportId: 'request-old',
    value: { credentialsRevealed: true },
  };

  assert.deepEqual(transportDetailForId('request-old', revealed), revealed.value);
  assert.equal(
    transportDetailForId('request-new', revealed),
    undefined,
    'the old credential-bearing record must not remain visible while the new masked fetch is pending',
  );
});
