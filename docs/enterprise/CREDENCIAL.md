# Credencial da empresa

Proteção `credencial_empresa` (matriz: ligada e travada em escritório, empresa e regulado). Texto de apoio do bloco E.
O raciocínio completo, com as fontes, está na seção 3 do relatório do plano enterprise
(`/root/claude/projetos/dgclaw-oficial-auditoria/relatorio-plano-enterprise.md`, fora do repositório, lido em 18/10/2026).
Os termos da Anthropic mudam com frequência: releia "Legal and compliance" e "Authentication" do Claude Code
(code.claude.com/docs/en/legal-and-compliance e /authentication) antes de assinar cada contrato.

## Em uma tela

- Todo agente nasce com um **uso**: `pessoa` ou `setor`. Sem isso o `dgclaw agente criar` recusa.
- **Agente de pessoa** entra com o assento (Team ou Enterprise) da própria pessoa: `--uso pessoa --usuario <login>`, forma de
  pagar `assinatura`. O login vira o `dono` do agente no `agentes.json` e o agente entra na lista da pessoa.
- **Agente de setor** usa a chave de API da organização da empresa: `--uso setor --auth api`. A chave fica no cofre do agente.
- O modo `token` (`claude setup-token`) some do painel do agente e o Web recusa gravá-lo.
- Os agentes que já existiam antes da proteção aparecem no `dgclaw status` e no `dgclaw protecoes aplicar` como "sem uso
  definido". Defina com `dgclaw agente uso <slug> pessoa --usuario <login>` ou `dgclaw agente uso <slug> setor`.

## O que os termos permitem (resumo)

| Arranjo | Situação |
| --- | --- |
| Cada funcionário entra com o próprio assento, no próprio container, pelo `/login` | Permitido por escrito |
| A TI entra com o assento dela para o Admin | Permitido |
| VPS da empresa, binário oficial sem modificação | Permitido, com a DG Medeiros sob os Commercial Terms |
| Agente ligado 24 horas, com rotinas automáticas, no assento do funcionário | Zona cinza: confirmar por escrito com o time de vendas da Anthropic |
| Um agente de setor, usado por várias pessoas, entrando no assento de uma delas | Proibido (é dividir assento). Use chave de API da organização |
| Modo `token` com o código guardado pelo DG Claw | Evitar em empresa: o produto passaria a guardar credencial de assinatura |
| Funcionário entrando com a conta pessoal (Pro ou Max) no agente da empresa | Bloquear: dado da empresa iria para um plano de consumidor, sem DPA |

Regras dos termos que o DG Claw respeita: o binário do Claude Code é o oficial e sem modificação; o login é sempre o fluxo
da Anthropic (o DG Claw nunca coleta nem guarda credencial de assinatura); o DG Claw não remove nem desliga método de
autenticação do binário. "Bloquear o modo token" quer dizer só não oferecer a opção no painel e recusar a gravação do nosso
lado. Fixar a organização é o recurso oficial `forceLoginOrgUUID` (ver `docs/enterprise/POLITICAS.md`).

## Team ou Enterprise

| | Team | Enterprise |
| --- | --- | --- |
| Claude Code incluso | Sim | Sim |
| Assento | Standard (1,25x o uso do Pro) ou Premium (6,25x). Mínimo de 2 e máximo de 150 assentos | Por assento ou por consumo a preço de API, sob consulta |
| SSO | Sim | Sim |
| SCIM | Não | Sim |
| Logs de auditoria e Compliance API | Não | Sim |
| Retenção personalizada | Não | Sim |
| Zero Data Retention no Claude Code | Não | Só para conta qualificada, pedida à Anthropic |
| Treina com os dados | Não | Não |
| DPA | Incluso nos Commercial Terms | Incluso |
| Políticas gerenciadas do Claude Code | Sim, para a organização toda | Sim |
| Processamento no Brasil | Não existe | Não existe (regiões "us" e "global") |

Recomendação:

- **Escritório:** Team, com **assento Premium para quem tem agente ligado o dia todo**. O Standard se esgota rápido com agente 24 horas.
- **Empresa e regulado:** Enterprise, pelos logs de auditoria, SCIM, retenção configurável e a possibilidade de pedir ZDR.
- **Agentes de setor e rotinas compartilhadas:** chave de API da organização da empresa, cobrada por uso, sob os mesmos
  Commercial Terms e o mesmo DPA.
- **Bedrock ou Vertex:** só para a empresa que já concentra tudo na AWS ou no Google. Não há assento, as políticas gerenciadas
  da Anthropic não valem, e os modelos recentes em São Paulo rodam pelo perfil global, que pode processar fora do país.

## A frase que não se pode usar na venda

Nunca prometa "seus dados ficam no Brasil". O correto é: **"armazenamento no Brasil, processamento pelo modelo nos
EUA, sob DPA e sem treinamento"**. Nenhum plano da Anthropic tem processamento no Brasil hoje.

## Pendência humana antes do primeiro cliente

1. A DG Medeiros aceitar os **Commercial Terms** da Anthropic (organização comercial, que pode ser um plano Team ou uma conta de API).
2. Mandar um **e-mail ao time de vendas da Anthropic** descrevendo o arranjo (VPS da empresa, um assento por pessoa, agente
   persistente acionado por painel web, rotinas automáticas) e pedindo confirmação por escrito. Guardar a resposta.
   Junto, perguntar se a lógica do DG Claw que limpa variáveis de autenticação conforme o modo escolhido
   (`providers/catalogo.json`) se encaixa na regra de não restringir métodos de autenticação.
3. Fazer o primeiro contrato como piloto, no nível escritório e sem dado sensível, por 60 a 90 dias.

## Como funciona por dentro

| Peça | Onde | O que faz |
| --- | --- | --- |
| Validação na criação | `lib/enterprise/credencial.sh` (`ent_credencial_validar`, chamado por `agente_criar` em `bin/dgclaw`) | Exige `--uso`; `setor` exige `--auth api`; `pessoa` exige `--auth assinatura` e, com multiusuário, `--usuario` de um login que existe. Cada recusa diz o que faltou e por quê |
| Registro | `ent_depois_de_criar_credencial` | Grava `uso` e `dono` no `agentes.json`, acrescenta o agente na lista da pessoa (funcionário; o TI já vê todos) e audita `agente.uso` |
| Marca para o painel | `<casa>/config/credencial-empresa` (644, montada só leitura em `/run/dgclaw/config`) | O painel do agente (`panel/lib/provedores.js`) tira o modo `token` do catálogo e responde 403 se alguém pedir. Escrita na criação e em `dgclaw protecoes aplicar`; apagada se a proteção desliga |
| Web | `web/lib/cofre-rotas.js` | `POST /p/<slug>/api/provedor` com `auth: token` e `POST /p/<slug>/api/cofre` com `CLAUDE_CODE_OAUTH_TOKEN` voltam 403 com o motivo e sem gravar nada |
| Formulário de criação | `web/public/onboarding.js`, `web/lib/onboarding.js`, `web/bin/onboarding.js` | Mostra "Este agente é de uma pessoa ou de um setor?" (só com a proteção ligada, tutorial incluído); o helper do Admin passa `--uso` (e `--usuario`, o login de quem criou) ao `dgclaw agente criar` |
| Controle do servidor | `controle/catalogo.js` (`agente.criar`) | Parâmetros `uso` e `usuario`, repassados à CLI |
| Roteiro do Admin | `skills/criar-agente/SKILL.md` e `templates/admin-isolado/skills/criar-agente/SKILL.md` | A pergunta e o porquê (o assento é pessoal e intransferível) |

Mensagem que o Web mostra: "na versão empresa, cada pessoa entra com o próprio assento do Team ou do Enterprise, ou o agente
usa a chave de API da empresa".

## O que fica de fora

- Agente de **setor com `--auth api` e Claude Code**: com `forceLoginOrgUUID` ou `forceLoginMethod` no managed settings o Claude
  Code bloqueia `ANTHROPIC_API_KEY` na partida (documentação oficial, "Restrict login to your organization"). Por isso o managed
  settings de um agente de setor **não leva** essas duas chaves (ver `POLITICAS.md`). A chave vem do cofre da organização.
- O DG Claw não verifica se o assento é Team ou Enterprise: isso é do `forceLoginOrgUUID` (a organização) e da Anthropic.
- Troca de `uso` depois da criação muda só o registro (`dgclaw agente uso`); a forma de pagar do agente se troca pelo painel dele.
