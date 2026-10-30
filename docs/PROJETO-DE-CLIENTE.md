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
2. **O cliente passa o IP e a senha de root uma única vez**, por um canal seguro. Nunca por e-mail, nem por
   grupo de mensagens.
3. **Do nosso lado:** com a senha, entramos por SSH uma vez e instalamos o DG Claw oficial seguindo o
   [INSTALL.md](../INSTALL.md). Logo em seguida liberamos o nosso acesso por chave:

   ```
   sudo dgclaw suporte ligar --chave '<nossa linha ssh-ed25519 ...>' --dias 7
   ```

   Daí em diante entramos só por chave. A senha de root não é mais usada.
4. **Ajustes:** criação do agente pelo Admin, logins na Tela, chaves no cofre, rotinas combinadas.
5. **Entrega:** o cliente troca a senha de root no painel da Hostinger e roda `sudo dgclaw suporte desligar`
   (ou pede ao Admin que rode). Confira com `sudo dgclaw suporte status`: tem que dizer "suporte: desligado".

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
| Funciona sem navegador, então não esbarra no bloqueio do Cloudflare da Hostinger | Precisa da senha de root uma vez, no começo |
| O escopo é só aquela máquina | Quem tem a chave tem root, por isso o prazo curto e o registro |
| Revogar é apagar uma linha, e ela expira sozinha | |
| Fica no registro: `/var/log/dgclaw/suporte.log` guarda cada ligar e desligar, só com o fingerprint | |

O comando exige OpenSSH 8.2 ou mais novo (o Ubuntu 24.04 já tem) e só aceita `ssh-ed25519`, `ecdsa-sha2-nistp256`
ou `ssh-rsa` de 3072 bits ou mais. Ele mexe só nas linhas marcadas como do suporte; as outras chaves do root
ficam como estão.

## 4. Checklist de onboarding

**Antes**

- [ ] VPS comprada pelo cliente, Ubuntu 24.04
- [ ] IP recebido
- [ ] Senha de root recebida por canal seguro (e apagada da conversa depois de usada)
- [ ] Conta Claude ou Codex do cliente pronta para o login

**Instalação**

- [ ] DG Claw oficial instalado na versão atual da `main`
- [ ] `dgclaw status` limpo, sem linha FALHOU
- [ ] Aviso de atualização ligado (`dgclaw atualizar --aviso ligar`)
- [ ] Painel abrindo com Pulso, Operações, Rotinas, Pasta e Tela
- [ ] Caixa do cofre testada na conversa (guardar uma chave de teste e conferir o final)
- [ ] Regra de ação em massa presente no `CLAUDE.md` do agente (seção "Ação destrutiva ou em massa: pergunte antes")

**Agente**

- [ ] Criado pelo Admin
- [ ] Login do provedor feito
- [ ] Rotinas combinadas com o cliente, cada uma com o número estimado de itens que ela atinge

**Entrega**

- [ ] Cliente trocou a senha de root no painel da Hostinger
- [ ] `sudo dgclaw suporte desligar` rodado
- [ ] `dgclaw suporte status` diz "suporte: desligado"
- [ ] Cliente sabe como pedir o acesso de novo (ele manda a chave pública e roda `suporte ligar`, ou pede ao Admin)

## 5. Agente que nasceu fora do padrão

Ver o plano de migração da instalação de teste, combinado caso a caso.
