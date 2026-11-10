'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const clubs=require('../public/js/clubs');
test('club case, spacing, joined spelling and punctuation share the same key',()=>{
 const known=['CrossFit City','CF BAZA','RECORD'];
 for(const text of ['CROSSFITCITY','cross fit city',' CrossFit  City ','cross-fit-city'])assert.equal(clubs.canonical(text,known),'CrossFit City');
 assert.equal(clubs.canonical('рекорд пивовариха',known),'RECORD');
 assert.equal(clubs.canonical('cfbaza',known),'CF BAZA');
 assert.equal(clubs.canonical('New Club',known),'New Club');
});
test('club hints find transpositions and typos without silently merging distinct clubs',()=>{
 assert.ok(clubs.suggest('recrod',['RECORD','CF BAZA']).includes('RECORD'));
 assert.ok(clubs.suggest('crossfit citi',['CrossFit City']).includes('CrossFit City'));
 assert.equal(clubs.canonical('crossfit citi',['CrossFit City']),'crossfit citi');
 assert.deepEqual(clubs.suggest('crossfit',['CrossFit City','crossfitcity']),['CrossFit City']);
});
