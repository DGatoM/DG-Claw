# Projeto de cliente: o DG Claw oficial na VPS do próprio cliente

Este guia é para o time DG que monta um agente para um cliente. Ele diz qual é o padrão, o passo a passo, por
que o acesso é por chave SSH temporária e o que conferir antes de entregar.

## 1. O padrão

Todo agente de cliente nasce como **DG Claw oficial completo na VPS do próprio cliente**: o Admin que cria
agentes, o painel inteiro (Pulso, Operações, Rotinas, Pasta), o cofre com a caixa de senha na conversa e a Tela.
Nunca numa instalação de teste e nunca numa versão diferente da oficial.

Por quê: em 30/10/2026 o agente de um cliente nasceu numa instalação de teste, com painel velho, sem Pulso,
Operações, Rotinas, Pasta nem cofre, e o cliente ficou com um produto pela metade.

## 2. O fluxo, passo a passo

1. **O cliente compra a VPS dele na Hostinger.** Ubuntu 24.04 (o 22.04 também serve), com acesso root, pelo
   menos 2 GB de memória e 15 GB livres, que é o que o [INSTALL.md](../INSTALL.md) exige. Para mais de um ou dois
   agentes, escolha um plano com mais memória.
2. **O cliente nos dá o primeiro acesso.** Há dois jeitos, e o primeiro é o preferido:
   - **Preferido, sem senha:** o cliente cola a nossa chave pública no painel ou no console da Hostinger e passa só
     o IP. A senha de root nunca sai da mão dele. Essa chave colada no painel é permanente, e o `suporte ligar`
     recusa uma chave que já está no arquivo como acesso permanente. Por isso ela só serve para a instalação: logo
     depois de instalar, o cliente a tira do painel e nós ligamos o acesso temporário (passo 3).
   - **Alternativa, com a senha:** o cliente passa o IP e a senha de root uma única vez, por um canal seguro. Nunca
     por e-mail, nem por grupo de mensagens. A senha só vale até o nosso acesso por chave ser testado (passo 3).
3. **Do nosso lado:** entramos por SSH uma vez e instalamos o DG Claw oficial seguindo o
   [INSTALL.md](../INSTALL.md). Logo em seguida liberamos o nosso acesso por chave:

   ```
   sudo dgclaw suporte ligar --chave '<nossa linha ssh-ed25519 ...>' --dias 7
   ```

   Abrimos uma segunda sessão SSH, agora só por chave, e confirmamos que entra. **Assim que esse teste passar, e
   antes de qualquer ajuste, o cliente troca a senha de root no painel da Hostinger.** A senha antiga nunca fica
   valendo durante o trabalho. Daí em diante entramos só por chave.
4. **Ajustes:** criação do agente pelo Admin, logins na Tela, chaves no cofre, rotinas combinadas.
5. **Entrega:** pela própria conta dele, o cliente roda
   `sudo dgclaw suporte desligar --derrubar-sessoes` (ou pede ao Admin). O `desligar` tira a chave, lista as
   sessões SSH de root abertas agora (marcando a de quem roda o comando) e, com `--derrubar-sessoes`, encerra
   todas as outras. Sem essa opção, ele avisa quando ainda há outra sessão de root aberta e não diz que o
   acesso está desligado. Confira com `sudo dgclaw suporte status`: tem que dizer "suporte: desligado" e
   "sessoes SSH de root abertas agora: nenhuma" (a do próprio cliente pode aparecer, marcada como a dele).

**O `desligar` revoga só as chaves gerenciadas pelo suporte.** Ele não troca senhas e não mexe em outras chaves do
root. É por isso que a troca da senha de root, no passo 3, é obrigatória: se a senha que passamos continuasse
valendo, tirar a chave não encerraria o nosso acesso. Quem deu a senha a alguém, ou colou uma chave no painel,
precisa trocar a senha e conferir as chaves do root por conta própria.

A chave expira sozinha no prazo, mesmo se ninguém lembrar de desligar: o servidor passa a recusá-la na data
combinada, e um timer diário tira a linha vencida do arquivo. Se o trabalho precisar de mais tempo, ligue de novo
(o máximo de cada vez é 30 dias).

## 3. Por que SSH com chave temporária

É a nossa recomendação. As outras duas saídas que consideramos:

- **Chave de API da Hostinger entregue pelo cofre.** O token herda todas as permissões da conta do cliente
  (faturamento, domínios, outras VPS). E a API administra a máquina, mas não roda comando dentro dela, então não
  resolve o trabalho.
- **Túnel para injetar na sessão do Claude Code que roda lá.** Depende de uma sessão viva, é frágil, abre mais
  superfície de ataque e é difícil de revogar com certeza.

**SSH com chave temporária:**

| A favor | Contra |
|---|---|
| Funciona sem navegador, então não esbarra no bloqueio do Cloudflare da Hostinger | Precisa de um primeiro acesso: de preferência a nossa chave colada pelo cliente no painel, ou a senha de root uma vez, trocada logo depois do teste por chave |
| O escopo é só aquela máquina | Quem tem a chave tem root, por isso o prazo curto e o registro |
| Revogar é apagar uma linha, e ela expira sozinha | |
| Fica no registro: `/var/log/dgclaw/suporte.log` guarda cada ligar e desligar, só com o fingerprint. Chave vencida removida pelo timer fica também em `/var/lib/dgclaw/suporte/revogadas.log`, e o `dgclaw status` avisa se havia sessão de root aberta | |

O comando exige OpenSSH 8.2 ou mais novo (o Ubuntu 24.04 já tem) e só aceita `ssh-ed25519`, `ecdsa-sha2-nistp256`
ou `ssh-rsa` de 3072 bits ou mais. Ele mexe só nas linhas marcadas como do suporte; as outras chaves do root
ficam como estão.

## 4. Checklist de onboarding

**Antes**

- [ ] VPS comprada pelo cliente, Ubuntu 24.04
- [ ] IP recebido
- [ ] Primeiro acesso combinado: de preferência o cliente cola a nossa chave pública no painel da Hostinger (sem passar senha); ou a senha de root recebida por canal seguro (e apagada da conversa depois de usada)
- [ ] Conta Claude ou Codex do cliente pronta para o login

**Instalação**

- [ ] DG Claw oficial instalado na versão atual da `main`
- [ ] `dgclaw status` limpo, sem linha FALHOU
- [ ] Aviso de atualização ligado (`dgclaw atualizar --aviso ligar`)
- [ ] `sudo dgclaw suporte ligar` rodado e o nosso acesso por chave testado em uma segunda sessão
- [ ] **Cliente trocou a senha de root no painel da Hostinger logo depois desse teste, antes de qualquer ajuste** (e, se ele colou a nossa chave no painel, tirou essa chave de lá)
- [ ] Painel abrindo com Pulso, Operações, Rotinas, Pasta e Tela
- [ ] Caixa do cofre testada na conversa (guardar uma chave de teste e conferir o final)
- [ ] Regra de ação em massa presente no `CLAUDE.md` do agente (seção "Ação destrutiva ou em massa: pergunte antes")

**Agente**

- [ ] Criado pelo Admin
- [ ] Login do provedor feito
- [ ] Rotinas combinadas com o cliente, cada uma com o número estimado de itens que ela atinge

**Entrega**

- [ ] Senha de root confirmada como trocada desde o passo 3 (o `desligar` não revoga senhas)
- [ ] `sudo dgclaw suporte desligar --derrubar-sessoes` rodado pela conta do cliente
- [ ] `dgclaw suporte status` diz "suporte: desligado"
- [ ] Cliente sabe como pedir o acesso de novo (ele manda a chave pública e roda `suporte ligar`, ou pede ao Admin)

## 5. Agente que nasceu fora do padrão

Ver o plano de migração da instalação de teste, combinado caso a caso.
