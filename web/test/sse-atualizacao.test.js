'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {EventEmitter}=require('node:events');
const {abrirStream}=require('../lib/sse');
test('stream publica alteração de origem com mesmo ID e epoch',async()=>{
 const res=new EventEmitter();const eventos=[];let versao=1,encerra;
 res.writeHead=()=>{};res.flushHeaders=()=>{};res.end=()=>{};
 const concluido=new Promise(resolve=>{res.write=s=>{
  if(!s.startsWith('event: msgs'))return;
  const d=JSON.parse(s.split('data: ')[1].split('\n')[0]);eventos.push(d);
  if(eventos.length===1)versao=2;else resolve();
 }});
 encerra=abrirStream({req:{},res,agente:{slug:'teste'},since:0,tickMs:5,
  fontes:{versaoJs:()=>'',atividade:async()=>({estado:'ocioso'}),thread:async()=>({versao,avisos:[],msgs:[{id:'igual',ep:1,origin:versao===1?'rotina':'agente'}]})},log:()=>{}});
 let timeout;
 try{await Promise.race([concluido,new Promise((_,reject)=>{timeout=setTimeout(()=>reject(Error('não publicou a correção')),1000)})]);
  assert.deepEqual(eventos.map(e=>e.novas[0].origin),['rotina','agente']);assert.deepEqual(eventos[1].sumidas,[]);
 }finally{clearTimeout(timeout);encerra();}
});
