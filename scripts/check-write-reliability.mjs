// Isolated provider check. Does not test the public connector or live services.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
const repository = fileURLToPath(new URL('../', import.meta.url));
const req=createRequire(new URL('../providers/pi-dev/package.json', import.meta.url));
const {Client}=await import(req.resolve('@modelcontextprotocol/client'));
const {StdioClientTransport}=await import(req.resolve('@modelcontextprotocol/client/stdio'));
const root=await fs.mkdtemp(path.join(os.tmpdir(),'webharness-reliability-'));
const rows=[];
const hash=b=>createHash('sha256').update(b).digest('hex');
const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>!k.startsWith('MCP_')&&!k.startsWith('BRIDGE_')));
Object.assign(env,{MCP_DEV_PATH_MODE:'workspace',MCP_DEV_WORKSPACE_ROOT:root,MCP_DEV_STATE_DIR:path.join(root,'state'),MCP_DEV_SHELL_MODE:'unrestricted'});
let catalog;
async function operation(kind,fn){
 const start=performance.now();
 try {const details=await fn();rows.push({kind,ok:true,ms:performance.now()-start,...details});}
 catch(e){rows.push({kind,ok:false,ms:performance.now()-start,error:e.message});}
}
try {
 for(let cycle=0;cycle<5;cycle++){
  const transport=new StdioClientTransport({command:process.execPath,args:[path.join(repository,'providers/pi-dev/server.mjs')],env,stderr:'pipe'});
  const client=new Client({name:'reliability-investigation',version:'1.0.0'});
  await client.connect(transport);
  transport.stderr?.resume();
  try {
   for(let j=0;j<8;j++){
    const file=`c${cycle}-${j%4}.txt`;
    const content=`cycle=${cycle} step=${j} λ雪😀\n`+'bounded-content\n'.repeat(j*20);
    const bytes=Buffer.from(content);
    await operation('write',async()=>{
     const result=await client.callTool({name:'write',arguments:{path:file,content,overwrite:j>=4,expected_bytes:bytes.length,expected_sha256:hash(bytes)}});
     if(result.isError)throw Error(JSON.stringify(result));
     const actual=await fs.readFile(path.join(root,file));
     if(!actual.equals(bytes))throw Error(`FALSE_SUCCESS expected=${bytes.length} actual=${actual.length}`);
     const receipt=result.structuredContent;
     if(receipt?.bytes_written!==actual.length || receipt.sha256!==`sha256:${hash(actual)}`
       || receipt.outcome!==(j>=4?'replaced':'created') || !/^[a-f0-9-]{36}$/.test(receipt.operation_id)
       || receipt.operation_id!==result._meta?.['webharness/call-id']
       || result._meta?.['webharness/mutation-state']!=='published') throw Error('invalid write receipt');
     return {verifiedBytes:actual.length,sha256:hash(actual),receipt:result.content[0]?.text,structuredReceipt:!!result.structuredContent};
    });
    await operation('read',async()=>{
     const result=await client.callTool({name:'read',arguments:{path:file}});
     if(result.isError)throw Error(JSON.stringify(result));
     if(!result.content?.some(b=>b.type==='text'&&b.text.includes(`cycle=${cycle} step=${j}`)))throw Error('read marker missing');
    });
   }
   for(let j=0;j<2;j++)await operation('exec',async()=>{
    const result=await client.callTool({name:'exec',arguments:{argv:[process.execPath,'-e','process.stdout.write("reliability-ok")']}});
    if(result.isError||!JSON.stringify(result).includes('reliability-ok'))throw Error('exec failed');
   });
   for(let j=0;j<2;j++)await operation('discovery',async()=>{
    const result=await client.listTools();
    const signature=JSON.stringify(result.tools.map(t=>({name:t.name,schema:t.inputSchema})).sort((a,b)=>a.name.localeCompare(b.name)));
    if(catalog&&catalog!==signature)throw Error('catalog changed across provider restart');
    catalog=signature;
   });
  } finally {await client.close();}
 }
 const summary=Object.fromEntries([...new Set(rows.map(r=>r.kind))].map(kind=>{const rs=rows.filter(r=>r.kind===kind),times=rs.map(r=>r.ms).sort((a,b)=>a-b);return[kind,{operations:rs.length,failures:rs.filter(r=>!r.ok).length,medianMs:Math.round(times[Math.floor(times.length/2)]*100)/100,minMs:Math.round(times[0]*100)/100,maxMs:Math.round(times.at(-1)*100)/100}];}));
 if(process.argv[2]) await fs.writeFile(process.argv[2],JSON.stringify({scope:'isolated SDK stdio to pi-dev, five fresh provider processes, no public connector',summary,rows},null,2));
 console.log(JSON.stringify({operations:rows.length,summary,failures:rows.filter(r=>!r.ok)},null,2));
 if(rows.some(r=>!r.ok)) process.exitCode=1;
}finally{await fs.rm(root,{recursive:true,force:true});}
