# Aviso de versão nova do DG Claw

Quando o repositório oficial ganha uma versão nova (um PR mergeado na `main`), o DG Claw instalado
percebe sozinho e avisa o dono: uma faixa discreta no painel ("Nova versão disponível") com o resumo
do que mudou, e um recado ao Admin, que conta ao dono no chat e pergunta se ele quer instalar.

**Nada é baixado nem instalado sem o ok do dono.** O aviso só informa. Quem atualiza continua sendo o
`sudo dgclaw atualizar` ([ATUALIZAR.md](ATUALIZAR.md)), e o Admin só o roda depois de um sim explícito.

## O que é consultado, e o que sai do servidor

A cada 6 horas (e 15 minutos depois de ligar o servidor) um timer roda `scripts/checar-atualizacao.mjs`.
Ele faz até quatro leituras públicas, sem token e sem conta:

| O quê | Endereço | Para quê |
| --- | --- | --- |
| comparação de commits | `https://api.github.com/repos/DGatoM/DG-Claw/compare/<commit instalado>...main` | saber se a `main` tem commits que esta instalação não tem |
| CHANGELOG publicado | `https://raw.githubusercontent.com/DGatoM/DG-Claw/<commit novo>/CHANGELOG.md` | montar o resumo em linguagem de gente |
| VERSION publicado | `https://raw.githubusercontent.com/DGatoM/DG-Claw/<commit novo>/VERSION` | o número da versão, quando existe (404 é normal) |
| páginas seguintes da comparação | o mesmo endereço do primeiro item, com `page=N` | só quando há mais de 100 commits à frente |

O que sai do servidor: o IP, como em qualquer acesso, e o **commit instalado**, que vai dentro da URL.
Nenhum outro dado da instalação (domínio, nome do dono, agentes, conversas, chaves) é enviado.

Só há aviso quando o GitHub diz que a `main` está **à frente** do commit instalado. Instalação feita de um
commit que não existe no GitHub (404), de outra branch ou com histórico diferente (`behind`/`diverged`)
fica sem aviso, com o motivo registrado.

## O resumo do que mudou

O script baixa o `CHANGELOG.md` publicado e compara, item a item, com o `CHANGELOG.md` instalado
(`/opt/dgclaw/app/CHANGELOG.md`), usando a mesma quebra em itens e a mesma impressão digital do aviso de
novidades depois de atualizar ([NOVIDADES.md](NOVIDADES.md), código comum em `scripts/novidades-lib.mjs`).
Os itens que a instalação ainda não tem são as novidades. Sem item novo (ou sem CHANGELOG), o resumo usa o
título (primeira linha) de cada commit.

Tudo que volta do GitHub é **dado não confiável**: validado (todo commit tem 40 caracteres hexadecimais),
sem caracteres de controle, com cada item cortado em 400 caracteres, no máximo 15 itens e cerca de 2500
caracteres no total. A faixa escapa o texto antes de desenhá-lo. **Nenhum texto vindo do GitHub entra no
recado ao Admin** (veja abaixo): o resumo existe só no painel.

## O que o dono vê

- **A faixa no painel**, no alto de todas as telas, numa linha: "Nova versão do DG Claw disponível
  (X → Y)". "Ver o que mudou" abre a lista, "Instalar" leva ao chat do Admin com o pedido "Quero instalar a
  atualização do DG Claw" já escrito no campo (ele só envia) e "Agora não" esconde o aviso até sair uma
  versão mais nova. Rotas em `web/docs/ATUALIZACAO.md`.
- **O recado ao Admin**, uma vez por versão publicada e com pelo menos 20 horas entre dois recados. O Admin
  roda com permissão total, então o recado tem **só texto fixo e dados já validados** (versão instalada,
  versão publicada e quantas mudanças estão à frente). Ele diz que saiu versão nova, que o resumo está na
  faixa do painel ("Ver o que mudou"), manda contar ao dono e perguntar, proíbe rodar `dgclaw atualizar`
  sem o sim explícito e proíbe ler o `estado.json` ou o CHANGELOG do GitHub para "descobrir" o que fazer.
  Vai com `injectWhenIdle`: o runner guarda o texto e só o digita quando o Admin termina o turno, sem
  intercalar com o que o dono está escrevendo. Se o Admin estiver fora do ar, o script tenta de novo na
  rodada seguinte. O token do Admin é lido do arquivo dentro do script e vai só no cabeçalho de um pedido
  para o próprio servidor (`127.0.0.1`); nunca aparece em argumento de comando nem em log.
- **`sudo dgclaw status`**: uma linha `atualizacao: ...` (em dia, versão nova disponível, última checagem
  falhou, aviso desligado ou ainda não verificado).

## Comandos

```bash
sudo dgclaw atualizar --checar            # confere agora; não baixa nem instala nada
sudo dgclaw atualizar --aviso desligar    # nenhuma consulta ao GitHub; a faixa some
sudo dgclaw atualizar --aviso ligar       # volta a conferir a cada 6 horas
```

`--aviso` troca só a linha `DGCLAW_AVISO_ATUALIZACAO` do `/etc/dgclaw/dgclaw.env` e liga ou desliga o timer.
Sem a linha, o aviso fica ligado. O instalador nunca cria nem reescreve essa linha: quem desligou continua
desligado depois de cada atualização.

Outras linhas opcionais do `dgclaw.env`, para quem mantém um fork: `DGCLAW_AVISO_REPO` (`dono/repositório`) e
`DGCLAW_AVISO_BRANCH`. Os valores são validados e a checagem recusa o que tiver `..` ou caractere estranho.

## Arquivos

| Arquivo | O que é |
| --- | --- |
| `scripts/checar-atualizacao.mjs` | a checagem (Node 22, sem dependências); roda como root |
| `scripts/novidades-lib.mjs` | quebra do CHANGELOG em itens e impressão digital, comuns ao aviso de novidades |
| `dgclaw-checar-atualizacao.service` / `.timer` | unidade endurecida (`ProtectSystem=strict`, escreve só em `/var/lib/dgclaw/web/atualizacao` e `/var/log/dgclaw`) e o timer de 6 horas |
| `/var/lib/dgclaw/web/atualizacao/estado.json` | o que a última checagem viu (pasta 700, arquivo 600) |
| `/var/lib/dgclaw/web/atualizacao/avisado-admin.json` | de qual versão o Admin já foi avisado e quando |
| `/var/lib/dgclaw/web/atualizacao/descanso.json` | qual versão o dono dispensou na faixa |
| `/var/log/dgclaw/checar-atualizacao.log` | uma linha por execução |
| `web/lib/atualizacao.js`, `web/public/atualizacao-faixa.js` | as rotas do painel e a faixa |
| `lib/aviso-atualizacao.sh` | `--checar`, `--aviso` e a linha do `dgclaw status` |

Duas checagens nunca rodam juntas: todas as entradas (a unidade do timer, `dgclaw atualizar --checar` e
`dgclaw atualizar --aviso`) executam o script sob `flock` no arquivo `/var/lib/dgclaw/web/atualizacao/.trava`
e esperam até 90 segundos por ela; sem conseguir, saem com erro e dizem o que fazer. O `.trava` só existe
como alvo do `flock` e nunca é apagado. Isso também garante que dois recados para o mesmo commit não saem.
O `dgclaw.env` é relido logo antes de gravar o estado e logo antes do recado: se o aviso foi desligado
no meio de uma checagem, o estado fica "desligado" e nada é enviado. `--aviso desligar` grava a linha,
desliga o timer, para o serviço, espera a trava, roda a checagem sem rede e só anuncia sucesso depois de ler
`desligado: true` no estado gravado (`ligar` faz o mesmo com `desligado: false`). Os caminhos partem de `/`
(a variável `DGCLAW_RAIZ`, só para teste, precisa ser absoluta).

**O que o script escreve na tela e no log**: só texto fixo e dados validados (versões, sha curto, número
de mudanças, motivos). O Admin lê a saída do `--checar` e o log; por isso o texto do CHANGELOG e os títulos
de commit, que vêm de fora, ficam apenas no `estado.json` para o painel, que o escapa. Para saber o que
mudou, o dono olha a faixa do painel.

Quando a checagem falha (rede, limite de consultas do GitHub, resposta estranha), o estado anterior é
mantido, o motivo vai para `erro` no `estado.json` e o script sai com código 1, dizendo o que falhou e o
que fazer.

## Testes

`bash tests/rodar.sh` roda tudo. As partes deste recurso: `aviso-atualizacao` (a checagem contra um GitHub
e um Admin falsos), `web` (`atualizacao.test.js` e `atualizacao-faixa.test.js`), `cli`
(`aviso-atualizacao.sh`) e `instalador` (`aviso-atualizacao.sh`, que confere que a linha
`DGCLAW_AVISO_ATUALIZACAO=0` e as linhas alheias sobrevivem).
