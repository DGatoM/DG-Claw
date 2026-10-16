const test = require('node:test');
const assert = require('node:assert/strict');
const { criar } = require('../public/midias-cache.js');
let seq = 0;
function bancada() {
  const agora = Math.floor(Date.now()/1000), disk = new Map(), calls = [];
  let lista = Array.from({length:100}, (_,i)=>({chave:String(i).padStart(4,'0'),ep:agora-100+i,cursor:String(agora-100+i)}));
  let erro = false, pausa;
  const fetch = async url => {
    const q = new URL(url,'https://exemplo.test').searchParams;calls.push(q);
    if (pausa) await pausa;
    if (erro) throw Error('sem rede');
    const todos = lista.filter(i=>(!q.has('cursor')||i.ep<Number(q.get('cursor'))) && (!q.has('desde')||i.ep>Number(q.get('desde')))).sort((a,b)=>b.ep-a.ep);
    const itens=todos.slice(0,20);
    return {ok:true,status:200,json:async()=>({ok:true,itens,proximo:todos.length>20?itens.at(-1).cursor:null,recente:String(lista.at(-1).ep)})};
  };
  const guardar = async (op,k,v) => { if(op==='limpar'){for(const x of disk.keys())if(x.startsWith(k))disk.delete(x);return;}return op==='put'?disk.set(k,structuredClone(v)):op==='delete'?disk.delete(k):disk.get(k); };
  const conta='teste-'+(++seq); const criarUm=(c=conta,mudou=()=>{})=>criar({conta:c,agente:'ana',base:'/api/v1/agents/ana',fetch,guardar,mudou});
  return { criarUm,calls,disk,novos(n){const ultimo=lista.at(-1).ep;lista.push(...Array.from({length:n},(_,i)=>({chave:'novo'+i,ep:ultimo+i+1,cursor:String(ultimo+i+1)})));},falhar(){erro=true;},pausar(p){pausa=p;} };
}
test('20 por página, teto inicial 60, reabertura só busca o delta e guarda o cursor antigo',async()=>{
  const b=bancada(), c=b.criarUm();await c.abrir('midias');assert.equal(c.estado('midias').itens.length,60);assert.equal(b.calls.length,3);
  const antes=c.estado('midias').proximo;b.novos(45);await c.abrir('midias');
  assert.equal(c.estado('midias').itens.length,105);assert.equal(c.estado('midias').proximo,antes);
  assert.ok(b.calls.slice(3).every(q=>q.has('desde')));assert.equal(b.calls.length,6);
  await c.mais('midias');assert.equal(c.estado('midias').itens.length,125);
});
test('lista guardada aparece antes da rede; falha de rede mantém conteúdo e explica',async()=>{
  const b=bancada(),c=b.criarUm();await c.abrir('links');c.fechar();
  let libera; b.pausar(new Promise(r=>libera=r));
  let visto=0;const d=b.criarUm(undefined,(_,v)=>visto=Math.max(visto,v.itens.length));const p=d.abrir('links');
  await new Promise(r=>setImmediate(r));assert.equal(visto,60);libera();await p;
  b.falhar();await d.abrir('links');assert.equal(d.estado('links').itens.length,60);assert.match(d.estado('links').erro,/sem rede/);
});
test('contas isoladas; sair limpa metadados e resposta em voo não repovoa',async()=>{
  const b=bancada(),c=b.criarUm();await c.abrir('docs');
  const outra=b.criarUm('outra-conta');assert.equal(outra.estado('docs').itens.length,0);
  let libera;b.pausar(new Promise(r=>libera=r));const p=c.abrir('docs');await new Promise(r=>setImmediate(r));
  await c.limpar();libera();await p;assert.equal(c.estado('docs').itens.length,0);assert.equal(b.disk.size,0);
});
test('IndexedDB indisponível não impede primeira carga e não faz consulta duplicada',async()=>{
  let chamadas=0;const c=criar({conta:'sem-idb',agente:'a',base:'/api',mudou:()=>{},guardar:async()=>{throw Error('negado');},fetch:async()=>{chamadas++;return{ok:true,json:async()=>({ok:true,itens:[],recente:'zero',proximo:null})};}});
  await Promise.all([c.abrir('docs'),c.abrir('docs')]);assert.equal(chamadas,1);assert.match(c.estado('docs').avisoCache,/negado/);
});
