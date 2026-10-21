const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const fonte=fs.readFileSync(require('node:path').join(__dirname,'../public/conversa.js'),'utf8');
const ini=fonte.indexOf('let filaFala = Promise.resolve();');
const fim=fonte.indexOf('/* Fone no balão:');
// fatia: filaFala, falaNovas, cancelaFala, pararFala, pegaPedacoVoz, tocaPedaco e falar (código real)
const bloco=fonte.slice(ini,fim);

test('cancelar durante A impede B enfileirada de gerar voz ou tocar',async()=>{
 const tts=[];let libera;
 const player={pause(){},play:()=>Promise.resolve()};
 const ctx={console,AbortController,ouvintesChegada:[],msgs:[],faladas:new Set(),escuta:{since:0,ate:Date.now()+60000},lerRespostas:true,
  gravando:false,falando:false,pararPedido:false,continua:false,AGENTE:{id:'x'},player,
  btnParar:{style:{},textContent:''},ehResposta:()=>true,ehVisual:()=>false,legendaUtil:m=>m.text,
  setEstado(){},estadoOcioso(){},mostraAviso(){},mostraErro(){},comecaGravar(){},
  vozCache:new Map(),VOZ_CACHE_MAX:12,
  // dublê do pedaço: registra o texto e, para A, segura até o teste liberar
  pegaPedacoVoz:async t=>{tts.push(t);return{blob:t,partes:1};},
  tocaPedaco:t=>t==='A'?new Promise(r=>{libera=r;ctx.fimToque=r;}):Promise.resolve(),
  fimToque:null,faloAbort:null,faloGeracao:0};
 // o código real declara faloGeracao/fimToque/faloAbort em outro ponto: aqui vêm do contexto
 vm.createContext(ctx);
 vm.runInContext(bloco.replace(/^(let (faloGeracao|faloAbort|fimToque)|const (vozCache|VOZ_CACHE_MAX)).*$/gm,'').replace(/(async )?function pegaPedacoVoz[\s\S]*?\n}\n/,'').replace(/function tocaPedaco[\s\S]*?\n}\n/,''),ctx);
 ctx.msgs.push({id:1,text:'A'});
 vm.runInContext('falaNovas()',ctx);
 await new Promise(r=>setImmediate(r));
 assert.deepEqual(tts,['A']);
 ctx.msgs.push({id:2,text:'B'});
 vm.runInContext('falaNovas()',ctx);
 vm.runInContext('cancelaFala()',ctx);
 if(libera)libera();
 await vm.runInContext('filaFala',ctx);
 await new Promise(r=>setImmediate(r));
 assert.deepEqual(tts,['A'],'B não pode gerar TTS depois do cancelamento');
});
