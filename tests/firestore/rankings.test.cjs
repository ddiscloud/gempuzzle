const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { before, after, beforeEach, test } = require('node:test');
const { initializeTestEnvironment, assertSucceeds, assertFails } = require('@firebase/rules-unit-testing');
const { doc, setDoc, getDoc, updateDoc, deleteDoc, collection, getDocs, query, where, orderBy, limit, setLogLevel } = require('firebase/firestore');

const root = path.join(__dirname, '../..');
const projectId = 'demo-gempuzzle-rules';
const adminUid = '8wyzC0zHPDSBYQNxhRzVHbNMyFx2';
const publishedId = 'maker_uid_1788832800000';
const maximum = Number.MAX_SAFE_INTEGER;
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const version = html.match(/const DATA_VERSION='([^']+)'/)[1];
const stageCount = vm.runInNewContext(fs.readFileSync(path.join(root, 'stages.js'), 'utf8') + '\nSTAGE_LIST.length;');
const rank = (overrides = {}) => ({
  uid: 'alice', nickname: '테스터', stage: '0', diff: 1,
  time: 60234.125, moves: 42, date: '2026-09-08T05:00:00.000Z', ...overrides
});
const rankId = value => `${value.stage}_${value.diff}_${value.uid}`;
const ranking = (db, value = rank()) => doc(db, 'rankings_v2', rankId(value));
let env, alice, bob, guest, admin;

before(async () => {
  // Fail closed when run without the local demo emulator.
  const address = process.env.FIRESTORE_EMULATOR_HOST || '';
  assert.match(address, /^(127\.0\.0\.1|localhost):[0-9]+$/, 'Run npm run test:rules to start the local emulator');
  const [host, port] = address.split(':');
  setLogLevel('silent');
  env = await initializeTestEnvironment({
    projectId,
    firestore: { host, port: Number(port), rules: fs.readFileSync(path.join(root, 'firestore.rules'), 'utf8') }
  });
  alice = env.authenticatedContext('alice').firestore();
  bob = env.authenticatedContext('bob').firestore();
  guest = env.unauthenticatedContext().firestore();
  admin = env.authenticatedContext(adminUid).firestore();
});
beforeEach(async () => { await env.clearFirestore(); });
after(async () => { if (env) await env.cleanup(); });

async function seed(documentPath, value) {
  await env.withSecurityRulesDisabled(ctx => setDoc(doc(ctx.firestore(), documentPath), value));
}
async function deny(write) {
  const error = await assertFails(write);
  assert.equal(error.code, 'permission-denied');
}

// Execute the actual existing client writer against the emulator, not a duplicated payload builder.
function submitFromClient(db, stage, diff, time, moves, nickname = '  플레이어  ') {
  const start = html.indexOf('function submitRanking(');
  const end = html.indexOf('\n// 특정 스테이지', start);
  assert(start >= 0 && end > start);
  return new Promise((resolve, reject) => {
    const context = vm.createContext({
      DATA_VERSION: version, userNickname: nickname, Date,
      window: { _fb: {
        db, currentUser: { uid: 'alice' }, doc, getDoc,
        setDoc(ref, data, ...options) {
          // The VM has a different Object prototype; retain the primitive field values
          // while passing an object from the SDK's own realm.
          const write = setDoc(ref, { ...data }, ...options);
          write.then(resolve, reject);
          return write;
        }
      } }
    });
    vm.runInContext(html.slice(start, end), context);
    context.submitRanking(stage, diff, time, moves);
  });
}

test('existing client submits a decimal-millisecond result and improves it', { timeout: 15000 }, async () => {
  assert.equal(version, 'v2', 'A new season requires explicit rules');
  await submitFromClient(alice, '0', 1, 60234.125, 42);
  let stored = (await getDoc(ranking(alice))).data();
  assert.equal(stored.time, 60234.125);
  assert.equal(stored.nickname, '플레이어');
  await submitFromClient(alice, '0', 1, 59123.5, 40);
  stored = (await getDoc(ranking(alice))).data();
  assert.equal(stored.time, 59123.5);
  assert.equal(stored.moves, 40);
});

test('all official stage indices in stages.js are accepted; the next index is rejected', async () => {
  for (let stage = 0; stage < stageCount; stage++) {
    const value = rank({ stage: String(stage) });
    await assertSucceeds(setDoc(ranking(alice, value), value));
  }
  const missing = rank({ stage: String(stageCount) });
  await deny(setDoc(ranking(alice, missing), missing));
});

test('all three difficulties have separate canonical documents', async () => {
  for (const diff of [1, 2, 3]) {
    const value = rank({ diff });
    await assertSucceeds(setDoc(ranking(alice, value), value));
  }
});

test('existing UGC client key works with an approved stage', { timeout: 15000 }, async () => {
  await seed(`published_stages/${publishedId}`, { name: '승인된 그림' });
  const stage = `ugc_${publishedId}`;
  await submitFromClient(alice, stage, 2, 12345.625, 12);
  assert.equal((await getDoc(ranking(alice, rank({ stage, diff: 2 })))).data().stage, stage);
});

test('UGC IDs retain underscores and Unicode without splitting them into identity fields', async () => {
  const id = '제작자_그림_123';
  await seed(`published_stages/${id}`, { name: '그림' });
  const value = rank({ stage: `ugc_${id}` });
  await assertSucceeds(setDoc(ranking(alice, value), value));
});

test('a pending submission alone cannot receive UGC rankings', async () => {
  await seed(`submissions/${publishedId}`, { uid: 'alice', status: 'pending' });
  const value = rank({ stage: `ugc_${publishedId}` });
  await deny(setDoc(ranking(alice, value), value));
});

test('removing a published stage prevents new ranking writes for that stage', async () => {
  await seed(`published_stages/${publishedId}`, { name: '그림' });
  const value = rank({ stage: `ugc_${publishedId}` });
  await assertSucceeds(setDoc(ranking(alice, value), value));
  await deleteDoc(doc(admin, 'published_stages', publishedId));
  await deny(updateDoc(ranking(alice, value), { time: 50000 }));
  await assertSucceeds(getDoc(ranking(guest, value)));
});

test('unauthenticated users can read/query both leaderboard sort orders, but cannot write', async () => {
  await seed('rankings_v2/0_1_alice', rank());
  await assertSucceeds(getDoc(ranking(guest)));
  for (const sort of ['time', 'moves']) {
    const result = await assertSucceeds(getDocs(query(collection(guest, 'rankings_v2'),
      where('stage', '==', '0'), where('diff', '==', 1), orderBy(sort, 'asc'), limit(20))));
    assert.equal(result.size, 1);
  }
  await deny(setDoc(ranking(guest), rank()));
});

test('a user cannot overwrite another user document by supplying their own UID', async () => {
  await seed('rankings_v2/0_1_alice', rank());
  await deny(setDoc(doc(bob, 'rankings_v2', '0_1_alice'), rank({ uid: 'bob', time: 1 })));
  assert.equal((await getDoc(ranking(alice))).data().uid, 'alice');
});

test('existing ownership is checked even when the new payload and document ID match the caller', async () => {
  await seed('rankings_v2/0_1_alice', rank({ uid: 'bob' }));
  await deny(setDoc(ranking(alice), rank()));
});

test('an owner cannot transfer a ranking to a different UID', async () => {
  await seed('rankings_v2/0_1_alice', rank());
  await deny(updateDoc(ranking(alice), { uid: 'bob' }));
});

test('an owner cannot change the stage or difficulty of an existing ranking', async () => {
  await seed('rankings_v2/0_1_alice', rank());
  await deny(updateDoc(ranking(alice), { stage: '1' }));
  await deny(updateDoc(ranking(alice), { diff: 2 }));
});

test('arbitrary, duplicate, and other-user document IDs are rejected on create', async () => {
  for (const id of ['arbitrary', '0_1_alice_copy', '0_1_bob', '0_2_alice', '1_1_alice']) {
    await deny(setDoc(doc(alice, 'rankings_v2', id), rank()));
  }
});

test('ranking deletion is denied to owners, other users, and the administrator', async () => {
  await seed('rankings_v2/0_1_alice', rank());
  for (const db of [alice, bob, admin]) await deny(deleteDoc(ranking(db)));
});

test('fractional positive time, safe numeric limits, and current nickname truncation remain valid', async () => {
  await assertSucceeds(setDoc(ranking(alice), rank({ time: 0.125, moves: 1 })));
  await assertSucceeds(setDoc(ranking(alice), rank({ time: maximum, moves: maximum })));
  await assertSucceeds(setDoc(ranking(alice), rank({ nickname: 'abcdefghijk ' })));
  await assertSucceeds(setDoc(ranking(alice), rank({ nickname: '😀'.repeat(6) })));
});

const invalidFields = [
  ['foreign UID', { uid: 'bob' }],
  ['numeric stage', { stage: 0 }],
  ['leading-zero stage', { stage: '00' }],
  ['negative stage', { stage: '-1' }],
  ['unpublished UGC', { stage: 'ugc_missing' }],
  ['UGC path separator', { stage: 'ugc_maker/other' }],
  ['zero difficulty', { diff: 0 }],
  ['fourth difficulty', { diff: 4 }],
  ['fractional difficulty', { diff: 1.5 }],
  ['string difficulty', { diff: '1' }],
  ['zero time', { time: 0 }],
  ['negative time', { time: -1 }],
  ['string time', { time: '123' }],
  ['NaN time', { time: NaN }],
  ['infinite time', { time: Infinity }],
  ['negative infinite time', { time: -Infinity }],
  ['unsafe time', { time: maximum + 1 }],
  ['zero moves', { moves: 0 }],
  ['negative moves', { moves: -1 }],
  ['fractional moves', { moves: 1.5 }],
  ['string moves', { moves: '42' }],
  ['unsafe moves', { moves: maximum + 1 }],
  ['empty nickname', { nickname: '' }],
  ['blank nickname', { nickname: '   ' }],
  ['long nickname', { nickname: '가'.repeat(13) }],
  ['numeric nickname', { nickname: 12 }],
  ['invalid date format', { date: 'yesterday' }],
  ['invalid date month', { date: '2026-13-08T05:00:00.000Z' }],
  ['numeric date', { date: 1788832800000 }],
  ['unrecognized field', { admin: true }]
];
for (const [label, change] of invalidFields) {
  test(`rejects ${label} on both create and update`, async () => {
    // Keep a syntactically valid document path, so the server rules reject the data.
    await deny(setDoc(ranking(alice), rank(change)));
    await seed('rankings_v2/0_1_alice', rank());
    await deny(setDoc(ranking(alice), rank(change)));
  });
}

test('every required field must exist on create and replacement update', async () => {
  for (const key of Object.keys(rank())) {
    await env.clearFirestore();
    const value = rank();
    delete value[key];
    await deny(setDoc(ranking(alice), value));
    await seed('rankings_v2/0_1_alice', rank());
    await deny(setDoc(ranking(alice), value));
  }
});

test('legacy malformed data stays readable and the owner can replace invalid non-identity fields', async () => {
  await seed('rankings_v2/0_1_alice', rank({ nickname: 'x'.repeat(100), extra: true }));
  await assertSucceeds(getDoc(ranking(guest)));
  await assertSucceeds(setDoc(ranking(alice), rank()));
  assert.deepEqual((await getDoc(ranking(alice))).data(), rank());
});

test('legacy rankings are public but all client writes are denied', async () => {
  const ref = doc(alice, 'rankings', 'legacy');
  await seed('rankings/legacy', { uid: 'alice', time: 1000, moves: 10 });
  await assertSucceeds(getDoc(doc(guest, 'rankings', 'legacy')));
  await assertSucceeds(getDocs(collection(guest, 'rankings')));
  await deny(setDoc(doc(alice, 'rankings', 'new'), rank()));
  await deny(updateDoc(ref, { time: 100 }));
  await deny(deleteDoc(ref));
});

test('unlisted ranking versions, similarly named collections, and unrelated paths are denied', async () => {
  for (const name of ['rankings_v3', 'rankings_backup', 'rankingsAnything', 'private_data']) {
    await deny(setDoc(doc(alice, name, '0_1_alice'), rank()));
    await deny(getDoc(doc(guest, name, '0_1_alice')));
  }
});

test('personal nickname and nested records retain owner-only access', async () => {
  for (const documentPath of ['users/alice', 'users/alice/records_v2/0_1']) {
    await assertSucceeds(setDoc(doc(alice, documentPath), { nickname: '내 정보' }));
    await assertSucceeds(getDoc(doc(alice, documentPath)));
    for (const db of [guest, bob]) {
      await deny(getDoc(doc(db, documentPath)));
      await deny(setDoc(doc(db, documentPath), { nickname: '다른 사람' }));
    }
    await assertSucceeds(deleteDoc(doc(alice, documentPath)));
  }
});

test('submission creation and administrator review keep their existing permissions', async () => {
  const value = { uid: 'alice', status: 'pending', name: '그림' };
  await assertSucceeds(setDoc(doc(alice, 'submissions', 'alice_example'), value));
  await deny(setDoc(doc(bob, 'submissions', 'bob_example'), value));
  await deny(setDoc(doc(guest, 'submissions', 'guest_example'), value));
  await deny(setDoc(doc(alice, 'submissions', 'already_approved'), { ...value, status: 'approved' }));
  await deny(getDoc(doc(alice, 'submissions', 'alice_example')));
  await deny(updateDoc(doc(alice, 'submissions', 'alice_example'), { status: 'approved' }));
  await assertSucceeds(getDoc(doc(admin, 'submissions', 'alice_example')));
  await assertSucceeds(updateDoc(doc(admin, 'submissions', 'alice_example'), { status: 'approved' }));
  await deny(deleteDoc(doc(admin, 'submissions', 'alice_example')));
});

test('published stages retain public reads and administrator-only writes', async () => {
  const value = { name: '승인된 그림' };
  await deny(setDoc(doc(alice, 'published_stages', publishedId), value));
  await assertSucceeds(setDoc(doc(admin, 'published_stages', publishedId), value));
  await assertSucceeds(getDoc(doc(guest, 'published_stages', publishedId)));
  await deny(updateDoc(doc(alice, 'published_stages', publishedId), { name: '변경' }));
  await deny(deleteDoc(doc(alice, 'published_stages', publishedId)));
  await assertSucceeds(updateDoc(doc(admin, 'published_stages', publishedId), { name: '수정된 그림' }));
  await assertSucceeds(deleteDoc(doc(admin, 'published_stages', publishedId)));
});
