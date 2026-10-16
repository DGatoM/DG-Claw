const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const { execFileSync } = require('node:child_process');
const { criarCompartilhados, cursor } = require('../lib/compartilhados');
const { subirWeb, pastaTemp } = require('./ajuda');

test('cursor composto, delta com mais de uma página, isolamento e cache do acervo', async () => {
  const msgs = Array.from({length:85},(_,i)=>({id:String(i).padStart(3,'0'),ep:100,text:'https://exemplo.test/'+i,dia:'dia',hhmm:'hora'}));
  let versao=1;
  const pagina=criarCompartilhados({thread:async()=>({msgs,versao,arquivo:'a',avisos:[]})});
  let proximo=null, ids=[];
  do {
    const q=new URLSearchParams({tipo:'links',limite:20});if(proximo)q.set('cursor',proximo);
    const r=await pagina({slug:'a'},q);ids.push(...r.itens.map(i=>i.chave));proximo=r.proximo;
  }while(proximo);
  assert.equal(ids.length,85);assert.equal(new Set(ids).size,85);
  const desde=cursor('a','links',100,'084:0');msgs.push({id:'novo',ep:101,text:'https://exemplo.test/novo'});versao++;
  const r=await pagina({slug:'a'},new URLSearchParams({tipo:'links',desde}));assert.equal(r.itens.length,1);
  await assert.rejects(pagina({slug:'b'},new URLSearchParams({tipo:'links',desde})),/outra conversa/);
  await assert.rejects(pagina({slug:'a'},new URLSearchParams({tipo:'docs',desde})),/outra conversa/);
});

test('API de acervo exige sessão e recusa cursor de outro agente', async () => {
  const s=await subirWeb({agentes:[{slug:'ana',nome:'Ana',tipo:'agente',runner:'http://127.0.0.1:1',agente_id:'ana1',chat_id:'c_ana'}]});
  try {
    const url='/api/v1/agents/ana/compartilhados?tipo=links';assert.equal((await s.c.get(url)).status,401);await s.login();
    assert.equal((await s.c.get(url+'&cursor='+cursor('outra','links',1,'x'))).status,400);
    assert.equal((await s.c.get(url+'&limite=999')).status,400);
  }finally{await s.fechar();}
});

test('miniatura é JPEG até 320 pixels, reaproveita cache e nunca devolve o original', async () => {
  const dir=pastaTemp('thumb-real'), arq=path.join(dir,'grande.bmp');
  execFileSync('ffmpeg',['-hide_banner','-loglevel','error','-f','lavfi','-i','testsrc=size=800x600','-frames:v','1','-threads','1',arq]);
  const s=await subirWeb({agentes:[{slug:'ana',nome:'Ana',tipo:'agente',runner:'http://127.0.0.1:1',agente_id:'ana1',chat_id:'c_ana',home_host:dir}]});
  try {
    const md=s.web.midia.registrar('ana',arq);await s.login();const r=await s.c.get(md.thumb);
    assert.equal(r.status,200,r.texto);assert.equal(r.headers['content-type'],'image/jpeg');assert.ok(r.buf.length<fs.statSync(arq).size/4);
    const thumb=path.join(dir,'resultado.jpg');fs.writeFileSync(thumb,r.buf);
    const info=JSON.parse(execFileSync('ffprobe',['-v','error','-show_entries','stream=width,height','-of','json',thumb]));
    assert.ok(info.streams[0].width<=320&&info.streams[0].height<=320);
    assert.deepEqual((await s.c.get(md.thumb)).buf,r.buf);
    const invalido=path.join(dir,'ruim.png');fs.writeFileSync(invalido,'nao é imagem');const ruim=s.web.midia.registrar('ana',invalido);
    const erro=await s.c.get(ruim.thumb);assert.equal(erro.status,503);assert.match(erro.texto,/miniatura/);assert.notEqual(erro.texto,'nao é imagem');
  }finally{await s.fechar();fs.rmSync(dir,{recursive:true,force:true});}
});
