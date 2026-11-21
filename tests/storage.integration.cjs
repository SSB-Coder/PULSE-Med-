// Optional real PostgreSQL-in-WASM checks. No cloud credentials or live database used.
// PULSE_PGLITE_MODULE=/path/to/@electric-sql/pglite node --test tests/storage.integration.cjs
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
let PGlite;
try { ({ PGlite } = require(process.env.PULSE_PGLITE_MODULE || '@electric-sql/pglite')); } catch {}

test('migration preserves histories once; PostgreSQL enforces ownership and same-owner record links', {skip: !PGlite}, async () => {
    const db = new PGlite();
    const a = '11111111-1111-4111-8111-111111111111';
    const b = '22222222-2222-4222-8222-222222222222';
    const recordB = '33333333-3333-4333-8333-333333333333';
    try {
        await db.exec(`
            create schema auth;
            create role anon;
            create role authenticated;
            create table auth.users(id uuid primary key);
            create function auth.uid() returns uuid language sql stable as $$
                select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
            $$;
            grant usage on schema auth to anon, authenticated;
            insert into auth.users values ('${a}'), ('${b}');
        `);
        await db.exec(fs.readFileSync('supabase/schema.sql', 'utf8'));
        await db.query('insert into public.medical_profiles(user_id, history) values ($1, $2)', [a, {conditions:'Migraines'}]);
        const migration = fs.readFileSync('supabase/chat_history_migration.sql', 'utf8');
        await db.exec(migration);
        const migrated = (await db.query('select * from medical_records')).rows;
        assert.equal(migrated.length, 1);
        const recordA = migrated[0].id;
        assert.equal(migrated[0].history.conditions, 'Migraines');
        assert.deepEqual((await db.query('select history from medical_profiles')).rows[0].history, {});
        await db.exec(migration);
        assert.equal((await db.query('select count(*)::int n from medical_records')).rows[0].n, 1);
        const policies = (await db.query("select tablename, count(*)::int n from pg_policies where tablename in ('medical_records','conversations') group by tablename")).rows;
        assert.equal(policies.length, 2);
        assert.ok(policies.every(row => row.n === 4));
        await db.query('insert into medical_records(id,user_id,name) values ($1,$2,$3)', [recordB,b,'Private B']);
        await db.exec(`set role authenticated; set request.jwt.claim.sub = '${a}';`);
        assert.deepEqual((await db.query('select id from medical_records')).rows.map(r=>r.id), [recordA]);
        await assert.rejects(db.query('insert into medical_records(user_id,name) values ($1,$2)', [b,'Forged owner']));
        assert.equal((await db.query('update medical_records set name=$1 where id=$2 returning id', ['Intrusion',recordB])).rows.length, 0);
        assert.equal((await db.query('delete from medical_records where id=$1 returning id', [recordB])).rows.length, 0);
        await assert.rejects(db.query('insert into conversations(user_id,medical_record_id) values ($1,$2)', [a,recordB]));
        const chatA = (await db.query('insert into conversations(user_id,medical_record_id,use_history,messages) values ($1,$2,true,$3) returning id', [a,recordA,[{role:'user',content:'My headache'}]])).rows[0].id;
        await db.exec(`set request.jwt.claim.sub = '${b}';`);
        assert.equal((await db.query('select * from conversations where id=$1', [chatA])).rows.length, 0);
        assert.equal((await db.query('update conversations set title=$1 where id=$2 returning id', ['Intrusion',chatA])).rows.length, 0);
        assert.equal((await db.query('delete from conversations where id=$1 returning id', [chatA])).rows.length, 0);
        await db.exec(`set request.jwt.claim.sub = '${a}';`);
        await db.query('delete from medical_records where id=$1', [recordA]);
        assert.equal((await db.query('select medical_record_id from conversations where id=$1',[chatA])).rows[0].medical_record_id, null);
        await db.exec('reset role');
        await db.exec(migration);
        assert.equal((await db.query('select count(*)::int n from medical_records where user_id=$1',[a])).rows[0].n, 0, 'Re-running migration must not resurrect deleted history');
        await db.exec('set role anon');
        await assert.rejects(db.query('select * from medical_records'));
        await assert.rejects(db.query('select * from conversations'));
    } finally { await db.close(); }
});
