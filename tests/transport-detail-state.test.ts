import assert from 'node:assert/strict';
import test from 'node:test';

import { transportDetailForId } from '../src/web/transport-detail-state.js';

test('a stale transport detail is hidden synchronously when the active request changes', () => {
  const loaded = {
    transportId: 'request-old',
    value: { method: 'POST' },
  };

  assert.deepEqual(transportDetailForId('request-old', loaded), loaded.value);
  assert.equal(
    transportDetailForId('request-new', loaded),
    undefined,
    'the previous record must not remain visible while the next fetch is pending',
  );
});
