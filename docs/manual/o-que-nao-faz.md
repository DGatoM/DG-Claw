# O que o DG Claw não faz

Esta página existe para ninguém prometer o que o produto não entrega, nem a um cliente nem a si mesmo. Cada linha
foi conferida no código ou no documento oficial da área, diz o porquê em uma frase e, quando existe, aponta o que
fazer em vez disso. O que ainda está sendo construído fica em [em-desenvolvimento.md](em-desenvolvimento.md), e o que
vale só para a assinatura do Claude ou do Codex está em [PARIDADE-CODEX.md](../PARIDADE-CODEX.md).

## Admin e agentes

| O DG Claw não... | Porque | O que fazer em vez disso |
| --- | --- | --- |
| Dá canal externo ao Admin (Telegram, WhatsApp) | O Admin roda como root; um canal aberto ao mundo daria root a quem mandasse a mensagem. O comando `dgclaw-agente` recusa rodar nele (código de saída 2) | Ligue o canal num agente de trabalho |
| Faz o Admin ler e-mail ou abrir links de terceiros | A regra do projeto é o Admin falar só com o dono, pelo chat do painel, e tratar como dado o que vier de outro caminho | Peça a um agente de trabalho que leia o e-mail e resuma |
| Deixa o Admin convidar um colaborador pela API | As rotas de `/api/v1/colaboradores` aceitam só a sessão do dono no navegador; o Admin não tem credencial para o Web | Você convida na tela `/colaboradores` (menu do agente, "Convidar colaborador"). O comando para o Admin convidar está em [em-desenvolvimento.md](em-desenvolvimento.md) |
| Compartilha o Admin com colaborador | O Admin enxerga o servidor inteiro. A API recusa convite para ele (erro 400) | Compartilhe um agente de trabalho |
| Dá a um agente acesso ao servidor ou aos agentes vizinhos | Cada agente fica num container sem root, atrás de um firewall que descarta o tráfego para o servidor, o gateway, outros containers e redes privadas | Para o agente usar algo do servidor (lembretes, mesa, avisos), ele pede pela caixa (`dgclaw-api`), que só executa as rotas liberadas |
| Impede um agente de mandar dados para a internet | A saída para a internet fica aberta, porque o agente precisa falar com o provedor de IA. A proteção é começar com poucos poderes e tratar texto de fora como material, não ordem | Defina limite de gasto em cada chave do cofre e libere poderes aos poucos |
| Protege contra quem tem root no servidor | Quem é root enxerga tudo, inclusive o cofre | Proteja o acesso SSH da VPS e use o botão de emergência se suspeitar de invasão |

## Chaves, cofre e login

| O DG Claw não... | Porque | O que fazer em vez disso |
| --- | --- | --- |
| Mostra o valor de uma chave guardada | O cofre só mostra quem guardou, quando e os 4 últimos caracteres | Guarde de novo se perdeu o valor; ele só existe com você |
| Compartilha uma chave entre agentes | Cada agente tem o próprio cofre, para um vazamento não passar de um agente | Guarde a chave em cada agente que precisa dela |
| Esconde a chave de um agente comprometido | O agente precisa do valor para usar a chave; com `sudo` dentro do container, consegue lê-lo | Limite de gasto no provedor de cada chave |
| Deixa uma chave de API do painel criar outra | Se uma chave vazar, ela não consegue gerar uma substituta | Crie as chaves pela aba Cofre, entrando com a senha |
| Deixa uma chave de API do painel trocar a senha da Tela | A Tela controla um navegador logado nos seus sistemas | Troque pela aba Tela, ou com `dgclaw agente tela-senha` no servidor |
| Usa a `OPENAI_API_KEY` do cofre num agente Codex na assinatura | Ela disputaria com o login do ChatGPT | Use o login da assinatura do ChatGPT no agente |
| Deixa o colaborador entrar no cofre, trocar a conta de IA ou gravar na memória | O painel registraria a ação como sendo sua, e memória e arquivos viram instrução permanente do agente | Faça você mesmo, ou converse com o agente pela conversa |
| Deixa dois colaboradores num mesmo agente | A API recusa convite se o agente já tem colaborador ativo (erro 409) | Revogue o acesso atual antes de convidar outra pessoa |

## Canais e conectores

| O DG Claw não... | Porque | O que fazer em vez disso |
| --- | --- | --- |
| Conversa por WhatsApp em grupo, canal ou status | A ponte ignora grupos, listas, canais, status e reações; só atende conversas diretas de números da lista de permitidos | Converse em conversa individual com o número liberado |
| Aceita qualquer número no WhatsApp | O agente só responde a quem o dono liberou. Número fora da lista é descartado sem resposta | `dgclaw-agente canal whatsapp permitir <número>` |
| Garante o WhatsApp contra banimento | A ponte usa uma biblioteca não oficial, e a Meta pode banir o número | Use um número secundário, nunca o principal do negócio ([RISCO-DE-BLOQUEIO-DE-CONTA.md](../RISCO-DE-BLOQUEIO-DE-CONTA.md)) |
| Recebe mídia grande ou tipo desconhecido no WhatsApp | Imagem, áudio, vídeo e documento entram até 25 MB. Tipo que a ponte não lê chega como aviso de "tipo que a ponte ainda não lê". O envio de arquivo pelo agente vai até 64 MB, só de pastas permitidas | Mande o arquivo pelo clipe da conversa web |
| Anonimiza o que chega por WhatsApp, Telegram ou e-mail | A anonimização atua só no clipe da conversa web | Mande o documento pelo clipe da conversa |
| Manda e-mail pelo agente, de saída | O Gmail nasce só lendo: o agente pesquisa, lê e deixa rascunho. Enviar, responder, encaminhar e apagar ficam bloqueados | Peça ao agente com suas palavras para liberar o envio. Apagar continua bloqueado |
| Dá os conectores do claude.ai (Gmail, Agenda, Drive) a quem usa só a chave de API ou o token do `claude setup-token` | Os conectores só aparecem com o login da assinatura feito pelo `/login` do container | Faça o login da conta do agente pela página `/conectar` |

## Claude e Codex

| O DG Claw não... | Porque | O que fazer em vez disso |
| --- | --- | --- |
| Mostra, no painel, o pedido de permissão ou a pergunta de escolha de um agente Codex | O runner responde 501 (`PERMISSAO_SO_CLAUDE`, `PERGUNTA_SO_CLAUDE`): o Codex não expõe esses pedidos a ele | Responda pelo terminal do agente, ou use um agente Claude |
| Conecta o Telegram a um agente Codex | O motor Codex ignora o canal (`--channels`) do Telegram | Use um agente Claude para o Telegram. O WhatsApp consta como compatível com o Codex, mas ainda sem teste ao vivo |
| Aplica as regras de permissão por ferramenta e os ganchos do Claude no Codex | O Codex não lê o arquivo de configurações do Claude; o runner avisa no registro o que ignorou | Veja a tabela de paridade em [PARIDADE-CODEX.md](../PARIDADE-CODEX.md) |

## Proteção, avisos e emergência

| O DG Claw não... | Porque | O que fazer em vez disso |
| --- | --- | --- |
| Instala atualização sem o seu ok | O aviso de versão nova e os boletins só informam | Diga "sim" ao Admin, que roda `dgclaw atualizar --ok-do-dono` |
| Corrige sozinho qualquer falha | A ronda só aplica ações que uma pessoa escreveu antes no catálogo fechado, e hoje o catálogo tem uma proteção provisória | Peça ao Admin para analisar e aplicar a correção, com o seu sim |
| Mantém o corte de emergência depois de reiniciar o servidor | O corte vive na memória por desenho; depois do reinício a tela mostra "Falha de proteção" | `sudo dgclaw emergencia preparar` e `cortar` de novo, ou `religar` |
| Deixa o painel no ar durante o corte de emergência | O painel é servido pelo mesmo proxy que sai do ar | Confirme e religue por SSH pelo Tailscale |
| Esconde a conversa do modelo de IA com o modo escondido | Ele só troca por asteriscos o que aparece na sua tela | Para o agente não ver o dado, use a anonimização de documentos |
| Garante 100% na anonimização | Nenhum detector acha todos os nomes. Sem o detector instalado, só números de documento, telefone e e-mail são trocados | Confira documentos sensíveis e instale o detector de nomes |

## Backup e restauração

| O DG Claw não... | Porque | O que fazer em vez disso |
| --- | --- | --- |
| Guarda no backup o programa, a imagem e os containers | Vêm do GitHub e o instalador refaz; o backup fica menor | Reinstale com `dgclaw atualizar` ou `dgclaw imagem construir` |
| Guarda programas que você instalou dentro do container, fora da casa do agente | O container é refeito a cada atualização | Anote o que instalou e instale de novo depois de cada atualização |
| Guarda memória e conversas com `dgclaw backup --sem-casas` | Essa opção deixa de fora as casas dos agentes | Faça o backup completo |
| Restaura a conversa do Admin | Restaurar não toca nela, para o chat em que você está não voltar no tempo | A conversa do Admin entra no backup, mas a restauração a deixa como está |
| Restaura as casas dos agentes ao voltar uma atualização | `dgclaw atualizar --voltar` restaura configuração e Admin, não os dados dos agentes | Para os dados, use `dgclaw restaurar` com um backup da mesma versão |
| Restaura backup de outra versão sem aviso | Configuração e dados de uma versão podem não servir ao código de outra | `--mesmo-assim`, só quando você sabe o que está fazendo |
| Apaga backups antigos | Nenhum comando do DG Claw apaga backup | Peça ao Admin para apagar um específico; ele nunca apaga o mais recente |
| Guarda cópia fora da VPS | Um backup que fica só no servidor some junto com ele | Copie por `scp` ou `rsync` ([BACKUP.md](../BACKUP.md)) |

## Poderes e limites de uso

| O DG Claw não... | Porque | O que fazer em vez disso |
| --- | --- | --- |
| Mostra as abas Instagram e Reuniões sem o poder instalado | A rota responde 423 e a aba aparece com cadeado | Peça ao Admin para instalar o poder (`instagram` ou `meetings`) |
| Dá uso da assinatura de outro agente a um agente | Pela caixa, `GET /api/v1/uso` devolve só o uso do próprio agente | O dono vê todos no painel, em ☰ > Uso das assinaturas |
| Dá aos colaboradores a Mesa, os Lembretes e o uso da assinatura | São globais, de todos os agentes | Peça ao dono |
