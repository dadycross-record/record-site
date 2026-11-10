(function(root){
 'use strict';
 const aliases={recordпивовариха:'RECORD',рекорд:'RECORD',рекордпивовариха:'RECORD',центрспортарекорд:'RECORD'};
 const clean=s=>String(s||'').normalize('NFKC').trim().replace(/\s+/g,' ');
 const key=s=>clean(s).toLocaleLowerCase('ru').replace(/ё/g,'е').replace(/[^a-zа-я0-9]/g,'');
 function canonical(value,clubs){const text=clean(value),k=key(text);if(!k)return '';return aliases[k]||(clubs||[]).find(c=>key(c)===k)||text;}
 function distance(a,b){const d=Array.from({length:a.length+1},()=>Array(b.length+1).fill(0));for(let i=0;i<=a.length;i++)d[i][0]=i;for(let j=0;j<=b.length;j++)d[0][j]=j;for(let i=1;i<=a.length;i++)for(let j=1;j<=b.length;j++){d[i][j]=Math.min(d[i-1][j]+1,d[i][j-1]+1,d[i-1][j-1]+(a[i-1]===b[j-1]?0:1));if(i>1&&j>1&&a[i-1]===b[j-2]&&a[i-2]===b[j-1])d[i][j]=Math.min(d[i][j],d[i-2][j-2]+1);}return d[a.length][b.length];}
 function suggest(value,clubs){const q=key(value);if(!q)return [];const seen=new Set(),list=[];for(const raw of clubs||[]){const name=canonical(raw,[]),k=key(name);if(seen.has(k))continue;seen.add(k);let score=k===q?0:k.startsWith(q)?1:k.includes(q)?2:99;if(score===99&&q.length>=4&&Math.abs(q.length-k.length)<=2){const n=distance(q,k);if(n<=(q.length>=9?2:1))score=3+n;}if(score<99)list.push({name,score});}return list.sort((a,b)=>a.score-b.score||a.name.localeCompare(b.name,'ru')).slice(0,8).map(r=>r.name);}
 const api={key,clean,canonical,suggest,distance};if(typeof module==='object'&&module.exports)module.exports=api;else root.RecordClubs=api;
})(typeof globalThis==='object'?globalThis:this);
