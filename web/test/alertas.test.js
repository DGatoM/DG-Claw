'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { marcar, criarAlertas } = require('../lib/alertas');
const { subirWeb, pastaTemp, cliente } = require('./ajuda');
const { criarRunnerFalso } = require('./runner-falso');

test('prefixo literal do agente, nunca texto do dono ou citação', () => {
  assert.equal(marcar({origin:'agente',text:'[ENTREGA] Pronto'}).text,'Pronto');
  assert.equal(marcar({origin:'rotina',text:'[PEDIDO]\nAutoriza?'}).alerta,'pedido');
  for (const text of ['✅ Pronto','Uma [ENTREGA] pronta','[ENTREGA]colado','```\n[PEDIDO]']) assert.equal(marcar({origin:'agente',text}).alerta,undefined);
  assert.equal(marcar({origin:'dono',text:'[PEDIDO] Teste'}).alerta,undefined);
});

test('estado persiste, edições não ressuscitam e chats não se misturam', () => {
  const dir=pastaTemp('alertas'); const arq=path.join(dir,'alertas.json');
  try {
    const a=criarAlertas(arq,'c_a'), b=criarAlertas(arq,'c_b');
    const m={id:'origem',origin:'agente',ep:123,via:'plataforma',text:'Pronto',alerta:'entrega'};
    a.observar([m]); b.observar([m]); const id=a.listar()[0].id;
    assert.equal(b.reconhecer(id),false);
    assert.equal(a.reconhecer(id),true); assert.equal(a.reconhecer(id),true);
    const novo=criarAlertas(arq,'c_a');novo.observar([{...m,id:'editado',text:'Pronto de novo'}]);
    assert.equal(novo.listar().length,0);assert.equal(b.listar().length,1);
    assert.equal(novo.mensagem(id).text,'Pronto de novo');
    assert.equal(fs.statSync(arq).mode & 0o777,0o600);
    fs.writeFileSync(arq,'quebrado');assert.throws(()=>novo.listar(),/Preserve o arquivo/);
  } finally { fs.rmSync(dir,{recursive:true,force:true}); }
});

test('API recupera alertas fora da página, exige login/Origin, reconhece entre aparelhos e isola agente', async () => {
  const dir=pastaTemp('alertas-http');
  const tr=path.join(dir,'transcripts','sessao');fs.mkdirSync(tr,{recursive:true});
  const sid='sess-alertas-0001';
  const linhas=[];
  for(let i=0;i<90;i++) linhas.push(JSON.stringify({type:'assistant',timestamp:new Date(Date.UTC(2026,9,16,10,0,i)).toISOString(),message:{role:'assistant',content:[{type:'tool_use',id:'tool-'+i,name:'mcp__dgchat__reply',input:{chat:'c_ana',text:i===0?'[PEDIDO] Autoriza?':i===89?'[ENTREGA] Pronto':'Resposta '+i}}]}}));
  fs.writeFileSync(path.join(tr,sid+'.jsonl'),linhas.join('\n')+'\n');
  const runner=criarRunnerFalso({agenteId:'ana1',sessionId:sid});const porta=await runner.ouvir();
  const agente={slug:'ana',nome:'Ana',tipo:'agente',runner:`http://127.0.0.1:${porta}`,agente_id:'ana1',chat_id:'c_ana',transcripts_dir:path.join(dir,'transcripts'),home_host:dir,home_container:'/home/agente'};
  const s=await subirWeb({agentes:[agente,{...agente,slug:'outra',chat_id:'c_outra'}]});
  const url='/api/v1/agents/ana/alertas';
  try {
    assert.equal((await s.c.get(url)).status,401);await s.login();
    const outro=cliente(s.porta);await s.login(outro);
    const msgs=await s.c.get('/api/v1/agents/ana/messages?limit=2');
    assert.equal(msgs.json.msgs.length,2);assert.equal(msgs.json.msgs[1].alerta,'entrega');assert.equal(msgs.json.msgs[1].text,'Pronto');
    const lista=await s.c.get(url);assert.equal(lista.status,200,lista.texto);assert.equal(lista.json.alertas.length,2);
    const id=lista.json.alertas[0].id;
    const origem=await s.c.get(url+'/'+id+'/mensagem');assert.equal(origem.json.mensagem.text,'Autoriza?');assert.equal(origem.json.msgs.length,90);
    assert.equal((await s.c.post(url+'/'+id+'/visto',{origin:'https://intruso.example'})).status,403);
    assert.equal((await s.c.post('/api/v1/agents/outra/alertas/'+id+'/visto')).status,404);
    assert.equal((await s.c.post(url+'/'+id+'/visto')).status,200);
    assert.equal((await s.c.post(url+'/'+id+'/visto')).status,200);
    assert.equal((await outro.get(url)).json.alertas.length,1);
    assert.equal((await s.c.get('/api/v1/alertas/docs.md')).status,200);
    // O estado em disco continua sendo reconhecido por uma loja nova após restart.
    assert.equal(criarAlertas(path.join(s.dados,'alertas','ana.json'),'c_ana').listar().length,1);
    const novo = JSON.parse(linhas[0]); novo.timestamp='2026-10-17T10:00:00.000Z';
    novo.message.content[0].input.text='[ENTREGA] Nova sessão';
    fs.writeFileSync(path.join(tr,'novo.jsonl'),JSON.stringify(novo)+'\n');
    fs.renameSync(path.join(tr,'novo.jsonl'),path.join(tr,sid+'.jsonl'));
    assert.equal((await s.c.get(url)).json.alertas.length,2, 'troca de arquivo com versão incremental igual ainda descobre novos alertas');

  } finally {await s.fechar();await runner.fechar();fs.rmSync(dir,{recursive:true,force:true});}
});

test('Codex: marca também texto final e mantém mensagens do dono sem alerta', () => {
  const { criarLeitorRollout } = require('../lib/rollout');
  const dir = pastaTemp('alertas-codex');
  try {
    const arq = path.join(dir,'rollout.jsonl');
    const msg = (role,text,ts,phase) => JSON.stringify({timestamp:ts,type:'response_item',payload:{type:'message',role,phase,content:[{type:role==='assistant'?'output_text':'input_text',text}]}});
    fs.writeFileSync(arq,[msg('user','<dgchat from="Dono" chat="c_ana" msg="x">[PEDIDO] Teste</dgchat>','2026-10-16T12:00:00Z'),msg('assistant','[ENTREGA] Final pronta','2026-10-16T12:00:01Z','final_answer')].join('\n')+'\n');
    const leitor=criarLeitorRollout({log:()=>{},tz:'America/Sao_Paulo',midia:{registrar:()=>null}});
    const eventos=leitor.ler(arq,{slug:'ana',chat_id:'c_ana',home_host:dir,home_container:'/home/agente'}).eventos;
    assert.equal(eventos[0].alerta,undefined);assert.equal(eventos[1].alerta,'entrega');assert.equal(eventos[1].text,'Final pronta');
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
});
