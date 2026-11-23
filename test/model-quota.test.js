'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { fetchUserStatusFromHost } = require('../payload/dist/meter-collector');
const { resolveModelQuotaGroup } = require('../payload/dist/meter-core');

test('native quota summary supports shared Gemini windows and the separate Argon limit', async () => {
  const calls = [];
  const requestFn = async (method, body) => {
    calls.push([method, body]);
    if (method === 'GetUserStatus') return { userStatus: {} };
    if (method === 'GetAvailableModels') return {};
    if (method === 'RetrieveUserQuotaSummary') {
      return {
        response: {
          groups: [
            { displayName: 'Gemini Models', buckets: [
              { window: 'weekly', remainingFraction: 0.62 },
              { window: '5h', remainingFraction: 0.49 },
              { window: 'daily', remainingFraction: 0, disabled: true }
            ] },
            { displayName: 'Claude & GPT Models', buckets: [
              { window: 'weekly', remainingFraction: 0 }
            ] },
            { displayName: 'Gemini 4 Argon', buckets: [
              { window: 'weekly', remainingFraction: 0.55 }
            ] }
          ]
        }
      };
    }
    throw new Error(`Unexpected method: ${method}`);
  };

  const status = await fetchUserStatusFromHost({ requestFn, force: true, remoteHostId: 'model-quota-test' });
  assert.ok(calls.some(([method, body]) => method === 'RetrieveUserQuotaSummary' && body.forceRefresh === false));
  const groups = status.modelQuotaGroups;
  assert.equal(resolveModelQuotaGroup('Gemini 4 Neon High', groups).window, '5h');
  assert.equal(resolveModelQuotaGroup('Gemini 4 Neon High', groups).remainingFraction, 0.49);
  assert.equal(resolveModelQuotaGroup('Gemini 4 Argon High', groups).remainingFraction, 0.55);
  assert.equal(resolveModelQuotaGroup('Claude Opus', groups).remainingFraction, 0);
  assert.equal(resolveModelQuotaGroup('Unknown model', groups), null);
});
