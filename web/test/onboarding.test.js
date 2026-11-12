'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { subirWeb } = require('./ajuda');
const { criarRunnerFalso } = require('./runner-falso');
const { loja } = require('../lib/onboarding');
const { executar } = require('../bin/onboarding');

async function cenario(t) {
  const runner = criarRunnerFalso({agenteId:'admin'}), porta = await runner.ouvir();
  const web = await subirWeb({agentes:[{slug:'admin',tipo:'admin',nome:'Admin',provedor:'claude',runner:'http://127.0.0.1:'+porta,agente_id:'admin'}]});
  t.after(async()=>{await web.fechar(); await runner.fechar(); fs.rmSync(web.dir,{recursive:true,force:true});});
  return {web,runner};
}
const pedido = {id:'a'.repeat(32),nome:'Sofia',papel:'Organizar minha agenda',jeito:'Acolhedor e direto'};
test('formulário exige sessão e origem; salva e envia ao Admin uma única vez',async t=>{
  const {web,runner}=await cenario(t);
  assert.equal((await web.c.get('/api/v1/onboarding')).status,401);
  await web.login();
  assert.equal((await web.c.get('/api/v1/onboarding')).json.fase,'boas-vindas');
  assert.equal((await web.c.post('/api/v1/onboarding',{json:pedido,origin:false})).status,403);
  const r = await web.c.post('/api/v1/onboarding',{json:pedido});
  assert.equal(r.status,200,r.texto); assert.equal(r.json.fase,'solicitado');
  assert.equal(runner.rec.inputs.length,1);
  assert.match(runner.rec.inputs[0].text,/do visual Criar meu agente/);
  assert.match(runner.rec.inputs[0].text,/Confirmo a criação pelo formulário/);
  assert.doesNotMatch(runner.rec.inputs[0].text,/onboarding\.js|\/opt\//);
  assert.equal((await web.c.post('/api/v1/onboarding',{json:pedido})).status,200);
  assert.equal(runner.rec.inputs.length,1);
  assert.equal((await web.c.post('/api/v1/onboarding',{json:{...pedido,id:'b'.repeat(32)}})).status,409);
  assert.equal(fs.statSync(path.join(web.dados,'onboarding',pedido.id+'.json')).mode & 0o777,0o600);
});
test('validação recusa foto de outro chat, ids e campos inválidos antes de enviar',async t=>{
  const {web,runner}=await cenario(t); await web.login();
  for(const dado of [null,[],{...pedido,id:'../../escape'},{...pedido,nome:'<script>'},{...pedido,dono:'<script>'},{...pedido,dono:'a'.repeat(71)},{...pedido,papel:''},{...pedido,jeito:'a'.repeat(181)},{...pedido,foto:'foto-inexistente'}]) assert.equal((await web.c.post('/api/v1/onboarding',{json:dado})).status,400);
  assert.equal(runner.rec.inputs.length,0);
});
test('Admin indisponível mantém pedido e permite retomar entrega',async t=>{
  const {web,runner}=await cenario(t); await web.login();
  runner.opcoes.falhaInput={status:409,corpo:{error:'NO_PTY'}};
  assert.ok((await web.c.post('/api/v1/onboarding',{json:pedido})).status>=400);
  assert.equal((await web.c.get('/api/v1/onboarding')).json.fase,'erro-envio');
  runner.opcoes.falhaInput=null;
  assert.equal((await web.c.post('/api/v1/onboarding',{json:pedido})).json.fase,'solicitado');
});
test('helper usa argv separados, cria uma vez e só abre a badge após resposta nova',async t=>{
  const {web}=await cenario(t); await web.login();
  const nome='Sofia $(touch /tmp/nao-executar)';
  await web.c.post('/api/v1/onboarding',{json:{...pedido,nome}});
  let chamadas=0;
  const {EventEmitter}=require('node:events');
  const fakeSpawn=(bin,args,opts)=>{
    chamadas++; assert.equal(bin,'/usr/local/bin/dgclaw'); assert.equal(opts.shell,false); assert.equal(args[4],nome);
    const p=loja(web.dados).ler(pedido.id);
    const reg=JSON.parse(fs.readFileSync(web.agentesPath));reg.agentes.push({slug:p.slug,nome:p.nome,agente_id:p.slug,runner:'http://127.0.0.1:1',porta_painel:8301});fs.writeFileSync(web.agentesPath,JSON.stringify(reg));
    const emitter=new EventEmitter();setImmediate(()=>emitter.emit('exit',0));return emitter;
  };
  let r=await executar('criar',pedido.id,{web:web.web,spawn:fakeSpawn});assert.equal(r.fase,'login');
  assert.equal((await web.c.get('/api/v1/onboarding')).json.conversa,null);
  await executar('criar',pedido.id,{web:web.web,spawn:fakeSpawn});assert.equal(chamadas,1);
  let enviado=false;
  const faux={...web.web,conversa:{enviar:async()=>{enviado=true;return{status:200,corpo:{ep_enviado:100}};},thread:async()=>({msgs:enviado?[{id:'nova',origin:'agente',ep:101}]:[{id:'antiga',origin:'agente',ep:1}]})}};
  r=await executar('testar',pedido.id,{web:faux,esperaMs:20,intervaloMs:1});assert.equal(r.fase,'pronto');assert.equal(r.respostaId,'nova');
  const estado=(await web.c.get('/api/v1/onboarding')).json;assert.equal(estado.conversa,'/a/'+r.slug);
});
test('status de processo ou resposta antiga não conclui o teste do agente',async t=>{
  const {web}=await cenario(t);await web.login();await web.c.post('/api/v1/onboarding',{json:pedido});
  const db=loja(web.dados),p=db.ler(pedido.id);
  const registro={obter:()=>({slug:p.slug,tipo:'agente'})};
  const faux={...web.web,registro,conversa:{enviar:async()=>({status:200,corpo:{ep_enviado:100}}),thread:async()=>({msgs:[{id:'antiga',origin:'agente',ep:1}]})}};
  const {EventEmitter}=require('node:events');const chamadas=[];
  const spawnFalso=(bin,args)=>{chamadas.push(args);const e=new EventEmitter();setImmediate(()=>e.emit('exit',0));return e;};
  await assert.rejects(executar('testar',pedido.id,{web:faux,esperaMs:10,intervaloMs:1,reinicioMs:1,spawn:spawnFalso}),/ainda não respondeu/);
  assert.deepEqual(chamadas,[['agente','reiniciar',p.slug]]);
  assert.equal(db.ler(pedido.id).fase,'erro');assert.ok(!fs.existsSync(path.join(db.dir,pedido.id+'.lock')));
});
test('agente que só responde depois do reinício termina em pronto',async t=>{
  const {web}=await cenario(t);await web.login();await web.c.post('/api/v1/onboarding',{json:pedido});
  const db=loja(web.dados),p=db.ler(pedido.id);
  const registro={obter:()=>({slug:p.slug,tipo:'agente'})};
  const {EventEmitter}=require('node:events');
  let reiniciou=false,envios=0;const chamadas=[];
  const spawnFalso=(bin,args)=>{chamadas.push(args);reiniciou=true;const e=new EventEmitter();setImmediate(()=>e.emit('exit',0));return e;};
  const faux={...web.web,registro,conversa:{enviar:async()=>{envios++;return{status:200,corpo:{ep_enviado:100*envios}};},thread:async()=>({msgs:reiniciou&&envios>=2?[{id:'antiga',origin:'agente',ep:1},{id:'nova',origin:'agente',ep:200}]:[{id:'antiga',origin:'agente',ep:1}]})}};
  const r=await executar('testar',pedido.id,{web:faux,esperaMs:10,intervaloMs:1,reinicioMs:1,spawn:spawnFalso});
  assert.equal(r.fase,'pronto');assert.equal(r.respostaId,'nova');assert.equal(envios,2);
  assert.deepEqual(chamadas,[['agente','reiniciar',p.slug]]);
});
test('reinício que falha vira mensagem clara',async t=>{
  const {web}=await cenario(t);await web.login();await web.c.post('/api/v1/onboarding',{json:pedido});
  const p=loja(web.dados).ler(pedido.id);const {EventEmitter}=require('node:events');
  const faux={...web.web,registro:{obter:()=>({slug:p.slug,tipo:'agente'})},conversa:{enviar:async()=>({status:200,corpo:{ep_enviado:100}}),thread:async()=>({msgs:[]})}};
  const spawnFalso=()=>{const e=new EventEmitter();setImmediate(()=>e.emit('exit',1));return e;};
  await assert.rejects(executar('testar',pedido.id,{web:faux,esperaMs:5,intervaloMs:1,reinicioMs:1,spawn:spawnFalso}),/reiniciar o seu agente/);
});

test('pedido corrompido não derruba a lista nem o chat dos agentes',async t=>{
  const {web}=await cenario(t);await web.login();
  const db=loja(web.dados);db.gravar({...pedido,criado:new Date().toISOString(),fase:'solicitado'});
  fs.writeFileSync(db.arquivo(pedido.id),'json-interrompido');
  assert.equal((await web.c.get('/api/v1/onboarding')).status,500);
  assert.equal((await web.c.get('/api/v1/agents')).status,200);
  assert.equal((await web.c.get('/a/admin')).status,200);
});

const dadosConversa = {nome:'Bia',papel:'Cuidar do meu Instagram',jeito:'Descontraído',dono:'Ana'};
test('pedido gravado pela conversa segue criar/testar e mostra a animação do painel',async t=>{
  const {web}=await cenario(t); await web.login();
  const p=await executar('pedir',undefined,{web:web.web,dados:dadosConversa});
  assert.equal(p.fase,'solicitado');assert.equal(p.origem,'conversa');assert.equal(p.slug,'bia');assert.equal(p.dono,'Ana');
  assert.equal(p.foto,null);assert.equal(p.provedor,'claude');
  assert.equal(loja(web.dados).ultimo().id,p.id);
  const {EventEmitter}=require('node:events');
  const fakeSpawn=()=>{
    const reg=JSON.parse(fs.readFileSync(web.agentesPath));reg.agentes.push({slug:p.slug,nome:p.nome,agente_id:p.slug,runner:'http://127.0.0.1:1',porta_painel:8301});fs.writeFileSync(web.agentesPath,JSON.stringify(reg));
    const e=new EventEmitter();setImmediate(()=>e.emit('exit',0));return e;
  };
  // Com um agente não-admin no registro, o estado ainda mostra o pedido (antes virava 'inativo').
  let r=await executar('criar','atual',{web:web.web,spawn:fakeSpawn});assert.equal(r.fase,'login');
  let estado=(await web.c.get('/api/v1/onboarding')).json;
  assert.equal(estado.fase,'login');assert.equal(estado.nome,'Bia');assert.equal(estado.conversa,null);
  let texto=null;
  const faux={...web.web,conversa:{enviar:async(a,m)=>{texto=m.text;return{status:200,corpo:{ep_enviado:100}};},thread:async()=>({msgs:texto?[{id:'nova',origin:'agente',ep:101}]:[]})}};
  r=await executar('testar','atual',{web:faux,esperaMs:20,intervaloMs:1});
  assert.equal(r.fase,'pronto');
  assert.match(texto,/Conectar a Groq/);assert.match(texto,/Conectar o Gmail/);assert.match(texto,/Oi! Sou Ana/);
  estado=(await web.c.get('/api/v1/onboarding')).json;
  assert.equal(estado.fase,'pronto');assert.equal(estado.conversa,'/a/bia');
});
test('pedido pela conversa recusa dados ruins e segundo pedido em andamento',async t=>{
  const {web}=await cenario(t);
  await assert.rejects(executar('pedir',undefined,{web:web.web,dados:{...dadosConversa,dono:''}}),/seu nome/);
  await assert.rejects(executar('pedir',undefined,{web:web.web,dados:{...dadosConversa,dono:undefined}}),/seu nome/);
  await assert.rejects(executar('pedir',undefined,{web:web.web,dados:{...dadosConversa,papel:'linha 1\nlinha 2'}}),/a função.*sem quebras de linha/);
  await assert.rejects(executar('pedir',undefined,{web:web.web,dados:null}),/JSON com nome/);
  assert.equal(loja(web.dados).ultimo(),null);
  await executar('pedir',undefined,{web:web.web,dados:dadosConversa});
  await assert.rejects(executar('pedir',undefined,{web:web.web,dados:{...dadosConversa,nome:'Caio'}}),e=>e.status===409&&/em andamento/.test(e.message));
  await assert.rejects(executar('apagar','atual',{web:web.web}),/Uso: .*pedir com o JSON/);
});
test('nome repetido ganha sufixo e a CLI lê o pedido pelo STDIN',async t=>{
  const {web}=await cenario(t);
  const reg=JSON.parse(fs.readFileSync(web.agentesPath));reg.agentes.push({slug:'bia',nome:'Bia',agente_id:'bia',runner:'http://127.0.0.1:1'});fs.writeFileSync(web.agentesPath,JSON.stringify(reg));
  const p=await executar('pedir',undefined,{web:web.web,dados:dadosConversa});
  assert.match(p.slug,/^bia-[a-f0-9]{6}$/);
  const {spawnSync}=require('node:child_process');
  const r=spawnSync(process.execPath,[path.join(__dirname,'../bin/onboarding.js'),'pedir'],{input:'  ',encoding:'utf8'});
  assert.notEqual(r.status,0);assert.match(r.stderr,/Não chegou nada pelo STDIN.*\{"nome"/);
  const r2=spawnSync(process.execPath,[path.join(__dirname,'../bin/onboarding.js'),'pedir'],{input:'{ruim',encoding:'utf8'});
  assert.notEqual(r2.status,0);assert.match(r2.stderr,/JSON recebido pelo STDIN é inválido/);
});

test('loja: gravação de outro processo no mesmo tique do mtime da pasta não deixa a foto velha', () => {
  const dados = fs.mkdtempSync(path.join(os.tmpdir(), 'dgclaw-loja-'));
  try {
    const leitor = loja(dados), outro = loja(dados);
    const id = 'a'.repeat(32), base = { id, criado: new Date().toISOString(), slug: 'sofia' };
    // As duas gravações deixam a pasta com o mesmo mtime (segundos inteiros, para o valor voltar exato),
    // como acontece quando caem no mesmo tique do relógio do sistema de arquivos.
    const tique = Math.ceil(Date.now() / 1000) + 1;
    outro.gravar({ ...base, fase: 'login' });
    fs.utimesSync(leitor.dir, tique, tique);
    assert.equal(leitor.ultimo().fase, 'login');
    outro.gravar({ ...base, fase: 'testando' });
    fs.utimesSync(leitor.dir, tique, tique);
    assert.equal(fs.statSync(leitor.dir).mtimeMs, tique * 1000);
    assert.equal(leitor.ultimo().fase, 'testando');
  } finally { fs.rmSync(dados, { recursive: true, force: true }); }
});
