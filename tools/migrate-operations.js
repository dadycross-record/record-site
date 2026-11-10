'use strict';
const { Pool } = require('../lib/pg');
const { statements } = require('../lib/operations-schema');
async function main() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const db = new Pool(process.env.DATABASE_URL,1);
  await db.tx(async q=>{for(const sql of statements) await q(sql);});
  console.log('Judging and audit schema ready');
}
main().then(()=>process.exit(0)).catch(e=>{console.error(e.message);process.exit(1);});
