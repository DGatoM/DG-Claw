const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const fonte=fs.readFileSync(require('node:path').join(__dirname, '../public/conversa.js'),'utf8');
const bloco=fonte.slice(fonte.indexOf('function integra(d) {'),fonte.indexOf('/* ── Carregar:',fonte.indexOf('function integra(d) {')));
test('SSE corrige origem mantendo ID, ordem e contador de novas mensagens',()=>{
 let renders=0;
 const c=vm.createContext({msgs:[{id:'a',ep:1,origin:'rotina'},{id:'b',ep:2,origin:'dono'}],novasAbaixo:0,
 maisNovas:false,contadasAbaixo:new Set(),distanciaDoFim:()=>200,maiorEp:()=>2,
 limpaPendentes(){},render(){renders++},atualizaSeta(){},trataAvisosThread(){},ouvintesChegada:[],console});
 vm.runInContext(bloco,c);c.integra({novas:[{id:'a',ep:1,origin:'agente'}],sumidas:[]});
 assert.equal(c.msgs.length,2);assert.equal(c.msgs[0].origin,'agente');assert.equal(c.novasAbaixo,0);assert.equal(renders,1);
});
