const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const fonte=fs.readFileSync(require('node:path').join(__dirname,'../public/conversa.js'),'utf8');
const ini=fonte.indexOf('/* ── Fila de leitura');
const fim=fonte.indexOf('/* Fone no balão:');
// fatia: a fila, falaNovas, cancelaFala, pararFala, pegaPedacoVoz, tocaPedaco e tocarMensagemNaFila (código real)
const bloco=fonte.slice(ini,fim);

test('cancelar durante A impede B enfileirada de gerar voz ou tocar',async()=>{
 const tts=[];let libera;
 const player={pause(){},play:()=>Promise.resolve()};
 const ctx={console,AbortController,ouvintesChegada:[],msgs:[],faladas:new Set(),escuta:{since:0,ate:Date.now()+60000},lerRespostas:true,
  gravando:false,pedindoMic:false,gravacao:null,falando:false,pararPedido:false,continua:false,AGENTE:{id:'x'},player,
  btnParar:{style:{},textContent:''},ehRespostaFalavel:()=>true,ehVisual:()=>false,legendaUtil:m=>m.text,
  setEstado(){},estadoOcioso(){},mostraAviso(){},mostraErro(){},comecaGravar(){},
  vozCache:new Map(),VOZ_CACHE_MAX:12,
  // dublê do pedaço: registra o texto e, para A, segura até o teste liberar
  pegaPedacoVoz:async t=>{tts.push(t);return{blob:t,partes:1};},
  tocaPedaco:t=>t==='A'?new Promise(r=>{libera=()=>r(true);ctx.fimToque=()=>r(true);}):Promise.resolve(true),
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

test('fone com o microfone gravando ou abrindo não gera voz nem toca',async()=>{
 for(const estado of [{gravando:true},{pedindoMic:true},{gravacao:{}}]){
  const tts=[],tocou=[],avisos=[];
  const ctx=Object.assign({console,AbortController,ouvintesChegada:[],msgs:[],faladas:new Set(),escuta:null,lerRespostas:true,
   gravando:false,pedindoMic:false,gravacao:null,falando:false,pararPedido:false,continua:true,AGENTE:{id:'x'},
   player:{pause(){},play:()=>Promise.resolve()},btnParar:{style:{},textContent:''},ehRespostaFalavel:()=>true,ehVisual:()=>false,
   legendaUtil:m=>m.text,setEstado(){},estadoOcioso(){},mostraAviso:a=>avisos.push(a),mostraErro(){},comecaGravar(){},
   vozCache:new Map(),VOZ_CACHE_MAX:12,pegaPedacoVoz:async t=>{tts.push(t);return{blob:t,partes:1};},
   tocaPedaco:async t=>{tocou.push(t);return true;},fimToque:null,faloAbort:null,faloGeracao:0},estado);
  vm.createContext(ctx);
  vm.runInContext(bloco.replace(/^(let (faloGeracao|faloAbort|fimToque)|const (vozCache|VOZ_CACHE_MAX)).*$/gm,'').replace(/(async )?function pegaPedacoVoz[\s\S]*?\n}\n/,'').replace(/function tocaPedaco[\s\S]*?\n}\n/,''),ctx);
  ctx.msgs.push({id:1,text:'resposta'});
  vm.runInContext("ouvirAPartirDe({ id: 1, texto: 'resposta' })",ctx);
  await new Promise(r=>setImmediate(r));
  assert.deepEqual(tts,[],`${JSON.stringify(estado)}: não pode gerar voz`);
  assert.deepEqual(tocou,[],`${JSON.stringify(estado)}: não pode tocar`);
  assert.equal(avisos.length,1,'a pessoa vê o motivo');
 }
});

test('aparelho que não toca o pedaço para a fila e não pede mais voz',async()=>{
 const tts=[],avisos=[];
 const ctx={console,AbortController,ouvintesChegada:[],msgs:[],faladas:new Set(),escuta:null,lerRespostas:true,
  gravando:false,pedindoMic:false,gravacao:null,falando:false,pararPedido:false,continua:true,AGENTE:{id:'x'},
  player:{pause(){},play:()=>Promise.resolve()},btnParar:{style:{},textContent:''},ehRespostaFalavel:()=>true,ehVisual:()=>false,
  legendaUtil:m=>m.text,setEstado(){},estadoOcioso(){},mostraAviso:a=>avisos.push(a),mostraErro(){},comecaGravar(){avisos.push('MIC')},
  vozCache:new Map(),VOZ_CACHE_MAX:12,pegaPedacoVoz:async(t,i)=>{tts.push(t+':'+i);return{blob:i,partes:4};},
  tocaPedaco:async()=>false,fimToque:null,faloAbort:null,faloGeracao:0};
 vm.createContext(ctx);
 vm.runInContext(bloco.replace(/^(let (faloGeracao|faloAbort|fimToque)|const (vozCache|VOZ_CACHE_MAX)).*$/gm,'').replace(/(async )?function pegaPedacoVoz[\s\S]*?\n}\n/,'').replace(/function tocaPedaco[\s\S]*?\n}\n/,''),ctx);
 vm.runInContext("enfileiraFala({id:1,texto:'longa'});enfileiraFala({id:2,texto:'outra'})",ctx);
 await vm.runInContext('filaFala',ctx);
 await new Promise(r=>setImmediate(r));
 assert.deepEqual(tts,['longa:0','longa:1'],'só o pedaço 0 e o que já estava em voo; a segunda mensagem nem é pedida');
 assert.equal(ctx.faloAbort,null,'o pedido antecipado foi cancelado');
 assert.deepEqual(JSON.parse(vm.runInContext('JSON.stringify(estadoFilaLeitura())',ctx)),{tocando:null,pausada:null,fila:[]},'a fila foi descartada');
 assert.ok(!avisos.includes('MIC'),'sem microfone depois de falha de som');
});
