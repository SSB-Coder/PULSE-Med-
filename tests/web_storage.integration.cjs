const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
let PGlite;
try {({PGlite}=require(process.env.PULSE_PGLITE_MODULE||'@electric-sql/pglite'));} catch {}

test('web migration is repeatable; private counters and atomic account/global caps cannot be bypassed', {skip:!PGlite}, async()=>{
    const db=new PGlite();
    const a='11111111-1111-4111-8111-111111111111';
    const b='22222222-2222-4222-8222-222222222222';
    try {
        await db.exec(`create schema auth; create role anon; create role authenticated;
            create table auth.users(id uuid primary key);
            create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
            grant usage on schema auth to authenticated,anon;
            insert into auth.users values ('${a}'),('${b}');`);
        for (const file of ['schema.sql','chat_history_migration.sql','web_tools_migration.sql','web_tools_migration.sql'])
            await db.exec(fs.readFileSync('supabase/'+file,'utf8'));
        await db.exec(`set role authenticated; set request.jwt.claim.sub='${a}';`);
        for(let i=0;i<5;i++) assert.equal((await db.query('select public.claim_pulse_web_budget() ok')).rows[0].ok,true);
        assert.equal((await db.query('select public.claim_pulse_web_budget() ok')).rows[0].ok,false);
        await assert.rejects(db.query('select * from pulse_web_account_budget'));
        await assert.rejects(db.query('update pulse_web_global_budget set day_count=0'));
        await db.exec(`set request.jwt.claim.sub='${b}';`);
        assert.equal((await db.query('select public.claim_pulse_web_budget() ok')).rows[0].ok,true);
        await db.exec('reset role');
        const count=(await db.query('select minute_count from pulse_web_global_budget')).rows[0].minute_count;
        assert.equal(count,6,'Rejected account claims do not consume the global budget');
        await db.query('update pulse_web_account_budget set day_count=50 where user_id=$1',[b]);
        await db.exec(`set role authenticated; set request.jwt.claim.sub='${b}';`);
        assert.equal((await db.query('select public.claim_pulse_web_budget() ok')).rows[0].ok,false);
        await db.exec('reset role; update pulse_web_global_budget set day_count=500;');
        await db.exec(`set role authenticated; set request.jwt.claim.sub='${a}';`);
        assert.equal((await db.query('select public.claim_pulse_web_budget() ok')).rows[0].ok,false);
        await db.exec('reset role; set role anon;');
        await assert.rejects(db.query('select public.claim_pulse_web_budget()'));
        await assert.rejects(db.query('select * from pulse_web_global_budget'));
    } finally {await db.close();}
});
