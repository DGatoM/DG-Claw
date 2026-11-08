# Em desenvolvimento

Esta página é a lista de espera do manual. Aqui ficam os recursos que a equipe está construindo e que **ainda não
estão na `main`**. Nada do que está escrito abaixo é promessa: o nome, o comportamento e até a existência de cada
item pode mudar antes de chegar.

Quando um item entra na `main`, ele sai desta página e passa a ser descrito na página certa do manual (a de
colaboradores e agentes, a de segurança ou a das telas), com a rota ou o comando na [referência do Admin](referencia-admin.md).
O teste `bash tests/docs-em-dia/rodar.sh` avisa quando isso acontece: um recurso novo no código sem documento
reprova a verificação até alguém escrevê-lo no lugar certo. Por isso os nomes técnicos abaixo aparecem em palavras,
e não como caminho ou comando completo, para não contarem como "documentados" antes da hora.

Enquanto o item não chega, não prometa a um cliente. Para saber o que existe hoje, leia [o-que-nao-faz.md](o-que-nao-faz.md).

## Colaborador criado pelo Admin

**Ainda não está na `main`, pode mudar.**

Hoje só o dono convida colaborador, pela tela de colaboradores (menu do agente, "Convidar colaborador"), porque as
rotas de convite aceitam apenas a sessão do dono no navegador. A frente em andamento prevê que o Admin também
consiga convidar, por um comando do servidor chamado `dgclaw colaborador`, com as ações de criar, listar, reenviar o
convite e revogar o acesso.

O que não muda: o colaborador continua com acesso a um agente só, nunca ao Admin, e continua sem o cofre, as chaves
de API, a conta de IA e as credenciais de canal. Veja [o-que-nao-faz.md](o-que-nao-faz.md).

## Face ID (o cadeado)

**Ainda não está na `main`, pode mudar.**

Está previsto o acesso por Face ID, com uma tela chamada cadeado e rotas de API com esse nome. Hoje essa tela e
essas rotas não existem na `main`: o acesso ao painel é só por senha, descrito em [seguranca.md](seguranca.md). Não há mais
detalhe confirmado.
