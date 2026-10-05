import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { demandReleaseFormat } from './check-hybrid-live.mjs';

// Committed public files only. Everything the live checker reads from a chain is outside these tests.
const configText = readFileSync(new URL('../deployment/hybrid-mainnet.json', import.meta.url), 'utf8');
const committed = () => JSON.parse(readFileSync(new URL('../deployment/mainnet-addresses.json', import.meta.url), 'utf8'));

test('the committed release has the format the live checker requires', () => {
  demandReleaseFormat(committed(), configText);
});

test('a release with an altered retired record, label, profile binding or shape is refused before any chain read', () => {
  for (const [name, mutate] of Object.entries({
    'retired list removed': r => { delete r.retired; },
    'retired list emptied': r => { r.retired = []; },
    'retired address': r => { r.retired[0].address = r.contracts[2].address; },
    'retired chain': r => { r.retired[0].chainId = 8453; },
    'retired reason': r => { r.retired[0].reason = ''; },
    'second retired entry': r => { r.retired.push(r.retired[0]); },
    'label': r => { r.release = 'streams-mainnet-2026-10-04'; },
    'profile hash': r => { r.configHash = `0x${'0'.repeat(64)}`; },
    'schema': r => { r.schemaVersion = 1; },
    'status': r => { r.status = 'live'; },
    'fifth contract': r => { r.contracts.push(r.contracts[3]); },
    'registry name': r => { r.contracts[3].name = 'RoundRegistry'; },
    'registry chain': r => { r.contracts[3].chainId = 8453; },
    'no proxy record': r => { delete r.contracts[3].proxy; },
  })) {
    const release = committed(); mutate(release);
    assert.throws(() => demandReleaseFormat(release, configText), undefined, name);
  }
  assert.throws(() => demandReleaseFormat(committed(), `${configText} `));
});

test('a planned release records no creation; a deployed one may', () => {
  const FACTS = [[r => r.contracts[3], 'creationTransaction', `0x${'1'.repeat(64)}`], [r => r.contracts[3], 'creationBlock', '27900001'],
    [r => r.contracts[3].proxy, 'implementationCreationTransaction', `0x${'2'.repeat(64)}`], [r => r.contracts[3].proxy, 'implementationCreationBlock', '27900000']];
  const planned = () => { const release = { ...committed(), status: 'planned' }; for (const [at, key] of FACTS) at(release)[key] = null; return release; };
  demandReleaseFormat(planned(), configText);
  for (const [at, key, value] of FACTS) {
    const release = planned(); at(release)[key] = value;
    assert.throws(() => demandReleaseFormat(release, configText), /planned release must not record/, key);
    demandReleaseFormat({ ...release, status: 'deployed' }, configText);
  }
});
