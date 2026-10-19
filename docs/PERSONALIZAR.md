# Personalizar o seu DG Claw sem perder a mudança na próxima atualização

O DG Claw é seu, e você pode pedir ao Admin para ajustar o que quiser: um botão novo, uma cor, uma
habilidade, um jeito diferente de um agente trabalhar. Só que existe uma pegadinha: a atualização oficial
troca os arquivos do programa por completo. Uma mudança feita no lugar errado desaparece sozinha na
próxima vez que você pedir "atualiza o DG Claw". Este guia mostra onde cada tipo de mudança deve ficar,
para ela sobreviver. O Admin lê este documento antes de mexer em qualquer coisa.

> **Mudança importante para as personalizações.** Este aplicativo vai ser personalizado por vocês e
> continuar sendo atualizado pelo Danilo. Para manter a estabilidade e preservar as suas alterações,
> vale uma regra daqui para frente: toda personalização entra no registro de personalizações, e antes de
> mexer no programa convém ler a seção "A arquitetura em uma página", logo abaixo, para a mudança respeitar
> o núcleo do DG Claw.

## A arquitetura em uma página

Pense em lugares diferentes, cada um com a sua regra.

| Lugar | O que é | O que acontece na atualização |
| --- | --- | --- |
| O clone (a pasta onde você baixou o DG Claw, guardada em `DGCLAW_REPO`, no arquivo `/etc/dgclaw/dgclaw.env`) | A cópia do código, com o histórico de versões (git) | Recebe a versão nova |
| `/opt/dgclaw/app` | Cópia de trabalho do programa, de onde o painel, o Admin e a imagem dos agentes leem | É apagada e refeita a partir do clone |
| `/opt/dgclaw/admin` | A casa do Admin: instruções dele, habilidades próprias, registro das suas personalizações | Preservada |
| `/var/lib/dgclaw/agentes/<nome>/home` | A casa de cada agente: memória, identidade, personalidade, rotinas, habilidades | Preservada |
| `/etc/dgclaw` | Configurações e segredos (senha do painel, chaves, lista de agentes) | Preservada |

O ponto central: o instalador copia o clone para `/opt/dgclaw/app` com `rsync -a --delete`, que deixa a
pasta de destino idêntica à de origem e apaga o que não estiver lá. Se alguém editar um arquivo direto em
`/opt/dgclaw/app`, a mudança dura até a próxima instalação e some sem aviso.

**O que é o núcleo.** O núcleo é tudo o que a tabela acima chama de "troca na atualização": o código do
painel, o `runner/`, o instalador, o comando `dgclaw`, o firewall, a pasta `container/` e as habilidades
de fábrica. Ele não se mexe, ou só se mexe pela branch `personalizacoes`, com cuidado.

**Onde a personalização deve entrar, em ordem de preferência:**

1. **Um ponto de extensão.** Habilidade nova, identidade ou personalidade de um agente, instruções do
   Admin, configuração (a seção seguinte lista todos). Não esbarra em nada e não precisa de branch.
2. **Um arquivo novo e próprio, na branch `personalizacoes`.** Um arquivo que só você tem quase nunca
   cruza com a versão oficial. Editar um arquivo grande que muda toda semana, como `conversa.js`, cruza
   com frequência.
3. **Só por último, editar um arquivo do núcleo.** Quando não houver jeito, a mudança fica pequena e
   isolada.

Regra prática: prefira acrescentar a alterar, mantenha cada mudança pequena e isolada, e nunca renomeie
nem mova arquivos oficiais.

## Onde dá para mexer sem medo

Estes lugares a atualização não toca (ou só avisa, sem apagar o que é seu). Aqui o Admin pode trabalhar
direto, sem o procedimento da branch.

| O que você quer | Onde o Admin faz | Exemplo de pedido |
| --- | --- | --- |
| Uma habilidade nova para o Admin | `/opt/dgclaw/admin/.claude/skills/<nome>/SKILL.md`, com um nome que não seja de nenhuma habilidade de fábrica | "Admin, cria uma habilidade que me manda todo dia um resumo da saúde do servidor" |
| Uma habilidade nova para um agente | `~/.claude/skills/<nome>` dentro da casa dele | "Cria uma habilidade para a Bia montar o relatório de vendas do jeito que eu gosto" |
| Mudar o jeito do Admin trabalhar | `CLAUDE.md` ou `AGENTS.md` em `/opt/dgclaw/admin` | "Admin, daqui para frente sempre me avise antes de reiniciar um agente" |
| Identidade e personalidade de um agente | `IDENTITY.md` e `PERSONALITY.md` na casa dele | "Deixa a Bia mais direta e menos formal" |
| Rotinas de um agente | Pelo próprio agente (ficam na casa, em `.dgclaw/self-crons.json`) | "Todo dia útil às 8h, a Bia me manda a agenda" |
| Chaves de voz, limites de envio, fuso, endereços permitidos | `/etc/dgclaw/web.env` (a linha certa, sem apagar as outras) | "Admin, liga o microfone com a minha chave do Groq" |
| Configuração de um agente (assinatura, conexões, memória, arquivos) | Painel do próprio agente, em `/p/<nome>/` | "Conecta o Telegram da Bia" |
| Chaves de serviços externos | Cofre do agente, pelo painel dele | "Guarda esta chave da minha agenda no cofre da Bia" |

Algumas observações que evitam surpresa:

- **Nome diferente de fábrica.** O instalador só refaz as habilidades do Admin que ele mesmo traz
  (`criar-agente` e `trocar-dominio`). Uma habilidade com outro nome fica quieta. Se você pedir para
  alterar uma habilidade de fábrica, a mudança é desfeita na atualização. Peça uma habilidade nova, com nome
  próprio, ou siga o jeito certo mais abaixo.
- **Instruções do Admin.** Se você personalizou o `CLAUDE.md` ou o `AGENTS.md`, a atualização não o troca.
  A versão nova do modelo fica ao lado, com final `.novo`, e o Admin junta as novidades ao seu texto sem
  apagar nada seu.
- **Opções do `web.env`.** Existem as chaves de voz e de IA (`ELEVENLABS_API_KEY`, `GROQ_API_KEY`,
  `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`), `DGCLAW_WEB_MAX_UPLOAD_MB` (tamanho máximo de envio),
  `DGCLAW_WEB_MAX_TEXTO`, `DGCLAW_WEB_TZ` (fuso), `DGCLAW_WEB_ORIGENS` (endereços extras aceitos),
  `DGCLAW_WEB_AVISOS=off` e `DGCLAW_SIGILO_LIBERADOS` (nomes que o modo escondido nunca esconde). A lista
  completa está em `web/lib/config.js`. Mexa linha a linha: o arquivo também guarda a senha do painel.
- **Habilidades do agente que vêm de fábrica** (agenda, lembretes, memória e outras) são links para o
  programa. Uma habilidade sua, com outro nome na pasta `~/.claude/skills` do agente, não é tocada.
- **Não existe, por enquanto, um lugar para CSS, botões ou itens de menu próprios.** Veja o fim deste guia.

## O que a atualização troca

Tudo o que vem do repositório é substituído: o código do painel (`web/` e `panel/`), o `runner/`, as
habilidades de fábrica (`skills/`), os modelos (`templates/`), os `scripts/`, os `hooks/`, a imagem dos
agentes, as unidades do systemd e a pasta `.plataforma/` do Admin. Mudar qualquer um desses só é seguro
pelo caminho da branch `personalizacoes`, descrito a seguir.

Algumas pastas mudam muito de uma versão para outra, então têm mais chance de esbarrar numa personalização
sua. Em outubro de 2026, as mais mexidas foram:

| Pasta ou arquivo | Risco de esbarrar numa atualização |
| --- | --- |
| `web/server.js`, `web/public/conversa.js`, `conversa.html`, `conversa.css`, `sw.js` | Alto (a tela de conversa evolui toda semana) |
| `web/public/menu-lado.*`, `onboarding.*`, `mesa.*` | Alto |
| `templates/CLAUDE.md.tmpl`, `AGENTS.md.tmpl` e `templates/admin/` | Alto |
| `panel/public/js/app.js`, `index.html`, `css/main.css`, `panel/server.js` | Médio a alto |
| `web/lib/` e `panel/lib/` | Médio |
| `skills/` de fábrica | Médio |

Quanto menor e mais isolada a mudança, menor a chance de conflito. Um arquivo novo quase nunca esbarra em
nada. Um ajuste no meio de `conversa.js` esbarra com frequência.

## O que nunca mexer, e por quê

Mesmo que o Admin saiba fazer, estes itens ficam de fora. Um erro aqui deixa a máquina insegura ou os
agentes mudos.

- **O instalador** (`install.sh` e a pasta `lib/`) e **o comando `dgclaw`** (`bin/dgclaw`), incluindo o
  `dgclaw atualizar`. É a peça que sabe refazer tudo na ordem certa, com backup. Se ela for alterada, a
  atualização deixa de ser confiável.
- **O firewall** (`lib/firewall.sh` e as regras de rede). Ele impede que um agente alcance a máquina ou
  os outros agentes.
- **O cofre e os segredos**: `/etc/dgclaw/runner/*.token`, `/etc/dgclaw/proxy/*.segredo` e o `cofre.env` de
  cada agente. Trocar ou apagar derruba a conversa entre as peças ou perde chaves que só você tem.
- **A autenticação do painel**: login, hash da senha, link de primeiro acesso.
- **A pasta `container/`** e a forma como cada agente é isolado. Ela define o que o agente pode ver e fazer
  dentro da caixa dele.
- **Os ganchos de segurança** (`hooks/`) e os testes de isolamento.

Se o seu pedido exige mexer em algum desses, o Admin explica o risco e propõe outro caminho.

## O jeito certo de personalizar o programa

Para mudar o próprio programa (por exemplo, `web/public/conversa.js`), o Admin trabalha em uma branch
chamada `personalizacoes`, no clone. Uma branch é uma linha paralela de versões dentro do mesmo
repositório, e um commit é um ponto de gravação dentro dela, com nome e data.

Por que branch, e não um arquivo de mudanças solto: o git sabe reaplicar os seus commits por cima da versão
nova (`git rebase origin/main`) e aponta exatamente o ponto onde a sua mudança cruza com a oficial. Um
arquivo solto fora do clone perde o contexto e só funciona com `git apply --3way` sem uma base garantida.

Passo a passo que o Admin segue:

```bash
# 1. Entrar na branch. Na primeira vez ela nasce da versão instalada,
#    o DGCLAW_COMMIT do /etc/dgclaw/dgclaw.env, com o clone limpo (git status sem nada)
git -C <clone> switch -c personalizacoes <DGCLAW_COMMIT>   # primeira vez
git -C <clone> switch personalizacoes        # nas outras vezes

# 2. Editar os arquivos dentro do clone (nunca em /opt/dgclaw/app)

# 3. Gravar, nomeando cada arquivo
git -C <clone> add web/public/conversa.js web/public/conversa.css
git -C <clone> commit -m "Personalizacao: botao Resumo do dia na conversa"

# 4. Colocar no ar, usando o que está no clone (sem baixar nada)
sudo dgclaw atualizar --sem-baixar --ok-do-dono --segundo-plano
```

O passo 4 faz backup, reinstala o que está no clone, reconstrói a imagem e recria os agentes. É o
caminho seguro, porque passa pelas mesmas conferências de uma atualização de verdade. Depois, o Admin
repete o "Como testar" da entrada no registro e conta o resultado a você.

## O registro das personalizações

Cada mudança ganha uma entrada em `/opt/dgclaw/admin/PERSONALIZACOES.md`. Esse arquivo fica fora do
programa (a atualização não o toca) e entra no backup `admin.tar.gz`. Na primeira personalização, o Admin
copia o modelo de `templates/admin/PERSONALIZACOES.md` para lá. O formato é este, e o
`dgclaw atualizar` o lê:

```
## 2026-10-19 - Botão "Resumo do dia" na conversa
- Pedido: (o que você pediu, nas suas palavras)
- Arquivos: `web/public/conversa.js`, `web/public/conversa.css`
- Commit: abc1234
- Por quê: (o motivo, em uma frase)
- Como testar: (passo a passo curto que qualquer pessoa repete)
- Situação: ativa
```

- **Arquivos** são caminhos a partir da raiz do repositório, entre crases. Uma personalização feita só
  pelos lugares seguros (uma habilidade, a casa de um agente) também entra, com os caminhos fora do
  repositório. O comando ignora o que não é do repositório.
- **Situação** pode ser `ativa`, `desfeita` ou `absorvida pela versão oficial em AAAA-MM-DD` (quando a
  versão oficial passou a fazer a mesma coisa).
- O Admin atualiza a entrada sempre que o commit mudar, que os arquivos mudarem ou que a situação mudar.

## Quando chega uma atualização

Com o clone na branch `personalizacoes`, o `dgclaw atualizar` busca a versão nova e cruza os arquivos que
ela muda com os arquivos personalizados (pelo git e pelo registro). Duas situações:

**Sem cruzamento.** O comando faz o backup, guarda uma cópia da sua branch em
`personalizacoes-antes-<data>`, reaplica as suas mudanças por cima da versão nova (`git rebase
origin/main`), instala e lembra o Admin de testar cada personalização pelo "Como testar".

**Com cruzamento.** O comando para antes de mexer em qualquer coisa e mostra uma frase pronta, que o Admin
repassa a você:

> A personalização "Botão Resumo do dia na conversa" tem uma inconsistência com esta atualização: a versão
> nova também mudou `web/public/conversa.js`. Posso ajustar a minha mudança para conviver com a nova?

O Admin só ajusta depois do seu "sim". Se você preferir, pode pedir para abrir mão da personalização
(marcada como `desfeita`) ou para esperar.

Se o clone estiver em outra branch (a `main`, por exemplo) e existirem personalizações, o comando também
para antes do backup, porque instalaria a versão oficial sem elas. O Admin volta para a branch com
`git switch personalizacoes`. Só se você decidir instalar sem as personalizações é que ele usa
`--sem-personalizacoes`.

Para ver o cruzamento sem mudar nada, o Admin roda `sudo dgclaw atualizar --simular` (ou
`sudo dgclaw personalizacoes conferir`). Depois do seu sim, o ajuste segue o capítulo "Personalização
que cruza com a versão nova" do `docs/ATUALIZAR.md`.

## Quem já tinha o DG Claw antes desta versão

Se o seu DG Claw é anterior a esta funcionalidade, a primeira atualização faz uma migração. Antes de
copiar a versão nova, o instalador compara a pasta do programa (`/opt/dgclaw/app`) com a versão oficial
que estava instalada. O que alguém mudou direto ali é guardado em
`/opt/dgclaw/admin/personalizacoes-migracao/<data>/`, com estes arquivos: `LISTA.txt` (uma letra por arquivo: M mudou, A acrescentado, D apagado, P só a permissão,
L link, X outro tipo), `diff.patch`, `app-antes.tar.gz` e `LEIA.txt`. Quando não há com o que comparar, o
instalador guarda o programa inteiro e só repete a cópia se o programa tiver mudado desde a última. Fica também um levantamento pendente, marcado em
`/opt/dgclaw/admin/personalizacoes-migracao/PENDENTE`. Ele aparece mesmo quando nada foi mudado direto no
programa, porque ainda podem existir mudanças no clone, guardadas por atualizações antigas ou só
lembradas nas conversas com o Admin.

Na conversa seguinte, o Admin faz o levantamento:

```bash
sudo dgclaw personalizacoes levantar
```

O comando junta o que foi mudado direto no programa, as alterações e os commits no clone, os stashes
`dgclaw-atualizar-*` (mudanças guardadas por atualizações antigas) e os arquivos que o próprio Admin
editou, segundo as conversas dele. O Admin conta o que achou em linguagem simples e, para cada
personalização:

1. confirma com você se ainda quer essa mudança;
2. compara com a arquitetura acima;
3. reaplica na branch `personalizacoes` do jeito mais compatível, preferindo ponto de extensão ou
   arquivo novo;
4. registra no `PERSONALIZACOES.md`;
5. aplica com `sudo dgclaw atualizar --sem-baixar --ok-do-dono --segundo-plano` e testa;
6. no fim, roda `sudo dgclaw personalizacoes concluir`.

Nada é apagado: as cópias ficam na pasta da migração. Quem instalou do zero já nasce com o registro
criado e não passa por isso. Para ver, a qualquer momento, como as suas personalizações ficam diante da
versão nova, o Admin usa:

```bash
sudo dgclaw personalizacoes conferir
```

## Desfazer uma personalização

O Admin desfaz com `git revert`, que cria um commit novo que anula o antigo e preserva o histórico:

```bash
git -C <clone> revert <commit>
sudo dgclaw atualizar --sem-baixar --ok-do-dono --segundo-plano
```

Nunca com `git reset --hard`, que apaga trabalho sem volta. Depois, a entrada no registro muda para
`Situação: desfeita`. A entrada fica, para que se saiba o que já foi tentado.

## Sugestão para o futuro: um ponto de extensão para botões e CSS

Isto **não está implementado**. Hoje não existe nenhuma pasta de fora do programa de onde o painel leia CSS,
JavaScript ou itens de menu: tudo o que a tela mostra vem de `web/public/` e `panel/public/`, que a
atualização troca. A consequência é que um botão novo ou uma cor nova exigem o caminho da branch.

Uma forma de resolver: o painel passaria a ler uma pasta como `/var/lib/dgclaw/web/extras/`, preservada
na atualização, com um `extra.css` (carregado depois do estilo oficial) e um `menu.json` (itens extras do
menu lateral, com nome, ícone e destino). Com isso, "muda a cor do botão" e "põe um atalho para a minha
planilha no menu" virariam pedidos simples e sem risco de conflito. Seria preciso decidir o que um script
próprio poderia fazer, porque JavaScript solto na tela do painel enxerga as conversas. Até lá, vale o
procedimento da branch.
