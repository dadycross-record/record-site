'use strict';
/* Owner-only portable ZIP archive of the currently deployed site source and database snapshot.
   No GitHub credentials, environment variables, .git, or server runtime secrets are included. */
const fs=require('fs');
const path=require('path');
const zlib=require('zlib');
const crypto=require('crypto');
const ROOT=path.resolve(__dirname,'..');
const TOP_FILES=['server.js','package.json','package-lock.json','README.md','.gitignore','Dockerfile'];
const DIRECTORIES=['lib','public','tools','test'];
const SKIP_DIR=new Set(['.git','node_modules','.next','dist','build','coverage','.cache','.github','uploads','tmp','temp']);
const SKIP_FILE=/^(?:\.env(?:\..*)?|\.npmrc|\.netrc|id_rsa(?:\.pub)?|.*\.(?:pem|key|p12|pfx)|.*\.sqlite3?|.*\.db|.*\.log)$/i;
const MAX_FILE=48*1024*1024, MAX_ALL=180*1024*1024;
const crcTable=Array.from({length:256},(_,i)=>{
  let c=i;for(let j=0;j<8;j++)c=c&1?0xedb88320^(c>>>1):c>>>1;return c>>>0;
});
function crc32(buf){let c=0xffffffff;for(const b of buf)c=crcTable[(c^b)&255]^(c>>>8);return (c^0xffffffff)>>>0;}
function sourceFiles(root=ROOT){
 const files=[];let bytes=0;
 function visit(abs,rel){
  const stat=fs.lstatSync(abs);
  if(stat.isSymbolicLink())return;
  if(stat.isDirectory()){
   if(SKIP_DIR.has(path.basename(abs)))return;
   for(const name of fs.readdirSync(abs).sort())visit(path.join(abs,name),rel?rel+'/'+name:name);
   return;
  }
  if(!stat.isFile()||SKIP_FILE.test(path.basename(abs)))return;
  if(stat.size>MAX_FILE)throw Error('Слишком большой файл исходного кода: '+rel);
  bytes+=stat.size;if(bytes>MAX_ALL)throw Error('Исходный код превышает допустимый размер архива');
  files.push({name:'code/'+rel,data:fs.readFileSync(abs)});
 }
 for(const name of TOP_FILES){const file=path.join(root,name);if(fs.existsSync(file))visit(file,name);}
 for(const name of DIRECTORIES){const dir=path.join(root,name);if(fs.existsSync(dir))visit(dir,name);}
 if(!files.some(f=>f.name==='code/server.js'))throw Error('Не найден серверный код');
 if(!files.some(f=>f.name==='code/public/index.html'))throw Error('Не найден интерфейс');
 if(!files.some(f=>f.name==='code/lib/race-leaderboard.js'))throw Error('Не найден код лидерборда');
 return files;
}
function zip(entries){
 const locals=[],central=[];let offset=0;
 for(const {name,data:src} of entries){
  const filename=Buffer.from(name,'utf8'),data=Buffer.isBuffer(src)?src:Buffer.from(src);
  if(filename.length>65535||data.length>0xffffffff)throw Error('Недопустимый файл архива');
  const deflated=zlib.deflateRawSync(data,{level:6});
  const compressed=deflated.length<data.length?deflated:data,method=compressed===data?0:8,crc=crc32(data);
  const local=Buffer.alloc(30);local.writeUInt32LE(0x04034b50,0);local.writeUInt16LE(20,4);local.writeUInt16LE(0x800,6);local.writeUInt16LE(method,8);
  local.writeUInt32LE(crc,14);local.writeUInt32LE(compressed.length,18);local.writeUInt32LE(data.length,22);local.writeUInt16LE(filename.length,26);
  locals.push(local,filename,compressed);
  const header=Buffer.alloc(46);header.writeUInt32LE(0x02014b50,0);header.writeUInt16LE(20,4);header.writeUInt16LE(20,6);
  header.writeUInt16LE(0x800,8);header.writeUInt16LE(method,10);header.writeUInt32LE(crc,16);
  header.writeUInt32LE(compressed.length,20);header.writeUInt32LE(data.length,24);header.writeUInt16LE(filename.length,28);header.writeUInt32LE(offset,42);
  central.push(header,filename);offset+=local.length+filename.length+compressed.length;
 }
 if(entries.length>65535)throw Error('Слишком много файлов для ZIP');
 const cSize=central.reduce((n,b)=>n+b.length,0),end=Buffer.alloc(22);
 end.writeUInt32LE(0x06054b50,0);end.writeUInt16LE(entries.length,8);end.writeUInt16LE(entries.length,10);
 end.writeUInt32LE(cSize,12);end.writeUInt32LE(offset,16);
 return Buffer.concat([...locals,...central,end]);
}
function fullArchive(databaseGzip,{createdAt=new Date(),sourceVersion='unknown'}={}){
 const files=sourceFiles();
 const manifest={project:'RECORDIRK.RU',createdAt:new Date(createdAt).toISOString(),sourceVersion,
  databaseFile:'database/record-backup.json.gz',codeFolder:'code/',
  notice:'Database is a PostgreSQL application snapshot. Code is from the deployed application, not a GitHub repository export. Secrets and runtime environment are intentionally excluded.',
  codeFiles:files.length,dbSha256:crypto.createHash('sha256').update(databaseGzip).digest('hex')};
 return zip([{name:'README-backup.json',data:JSON.stringify(manifest,null,2)+'\n'},
  {name:'database/record-backup.json.gz',data:databaseGzip},...files]);
}
module.exports={fullArchive,zip,sourceFiles};
