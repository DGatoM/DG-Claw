# Arquitetura do DG Claw v1

O DG Claw reúne um painel web, um Admin e agentes de trabalho em uma VPS Ubuntu.
O dono entra pelo navegador e conversa com o Admin para criar seu primeiro agente.
Telegram e outros canais são conexões opcionais, configuradas depois.

## Componentes e caminho de uma mensagem

```text
Navegador do dono
      │ HTTPS + sessão autenticada
      ▼
Caddy (portas 80 e 443)
      │
      ▼
DG Claw Web (127.0.0.1:8300, ou a porta de --porta-painel)
      ├── conversa do Admin ──► runner do Admin ──► Claude Code ou Codex
      │                         (no servidor, como root)
      │
      └── conversa do agente ─► runner do agente ─► Claude Code ou Codex
                                (no container do agente)
```

O **Web** apresenta o chat, autentica o dono, encaminha mensagens e entrega arquivos.
O **runner** mantém a sessão do programa de IA, recebe os pedidos e acompanha seu estado.
O **MCP dgchat** permite que a sessão envie respostas e anexos para a conversa certa.
As respostas e os registros da sessão alimentam a conversa exibida no navegador.

O painel de cada agente, em `/p/<nome>/`, reúne configurações como assinatura, conexões,
arquivos e memória. O chat fica em `/a/<nome>`. O Admin tem a conversa `/a/admin`.

### Origem isolada do painel

O painel é um processo dentro do container do agente, e o navegador nunca o recebe na origem do Web.
Abrir `/p/<nome>/...` devolve uma moldura (`web/public/painel.html` e `painel-moldura.js`): o Web monta o
cabeçalho e o menu e põe o painel num iframe com `sandbox`, sem `allow-same-origin`. O iframe carrega
`/pv/<token>/...`, e o Web troca o token pela sessão, reescreve o caminho para `/p/<nome>/...` e repassa ao painel
pelo mesmo proxy de sempre, com o cabeçalho `X-DGClaw-Base: /pv/<token>` para o painel gerar os endereços
certos. Dentro do iframe o painel não carrega a casca do Web: `panel/public/js/casca-ponte.js` repassa à moldura,
por `postMessage`, só a aba ativa, o título e os itens extras do menu. O desenho e os limites estão em
[SEGURANCA.md](SEGURANCA.md#origem-isolada-dos-painéis).

## Admin e agentes de trabalho

O Admin é uma sessão normal de Claude Code ou Codex com permissão de administrador da VPS.
Sua pasta de trabalho é `/opt/dgclaw/admin`, e a autenticação aproveita o login existente no root.
Ele executa a CLI `dgclaw` para criar e cuidar dos agentes. Não recebe canais externos.

Cada agente de trabalho tem um container Podman, uma identidade, uma casa de arquivos e sua
própria configuração de acesso ao provedor. Dentro do container, a casa é `/home/agente`.
As credenciais do root não são copiadas para esses agentes. A assinatura é conectada pelo painel
do agente, e chaves de API, quando usadas, ficam no cofre.

A CLI reserva portas e faixas de usuários, cria os arquivos a partir dos modelos, configura o
container e cadastra o agente. A separação usa permissões de arquivos, namespaces de usuários,
montagens controladas e regras de rede. Os testes de isolamento conferem esses limites.

## Instalação e primeiro agente

O [instalador](../INSTALL.md) confere os requisitos, instala dependências, configura o HTTPS e o
firewall e liga o Web e o Admin. A senha do painel é guardada como hash. Ao terminar, a saída
mostra o endereço, o usuário e um link de primeiro acesso (uso único, 30 minutos) para a pessoa cadastrar
a senha e continuar no navegador. Só o hash do código fica em disco.

A imagem dos agentes fica para a primeira criação. A opção `--com-imagem` permite construí-la
antes, em segundo plano. Áudio e canais não são requisitos para entrar no Admin.

No primeiro acesso, um botão inicia a conversa. O formulário coleta nome, função, tom, nome do
dono e foto opcional. A geração de avatar ilustrado acontece no navegador, sem serviço de IA.
O Web salva o pedido e o envia ao Admin. O formulário não executa comandos no servidor.

O Admin usa o helper de criação para executar a CLI. A interface acompanha estados reais:
pedido recebido, criação, conexão da assinatura e teste. A apresentação final só aparece quando
uma nova resposta do agente chega após o teste. O clique abre a conversa dele.
O contrato está em [Primeiro agente pelo Admin](../web/docs/PRIMEIRO-AGENTE.md).

## Dados e serviços

| Local ou serviço | Responsabilidade |
| --- | --- |
| `/opt/dgclaw/app` | Código instalado |
| `/opt/dgclaw/admin` | Pasta de trabalho do Admin |
| `/etc/dgclaw` | Configurações, registro de agentes e segredos protegidos |
| `/var/lib/dgclaw` | Dados do Web e casas dos agentes |
| `/var/log/dgclaw` | Registros de instalação e funcionamento |
| `dgclaw-web` | Interface web e API autenticada |
| `dgclaw-admin` | Execução da sessão administradora |
| `dgclaw-imagem` | Construção da imagem dos agentes, quando solicitada |
| `dgclaw-anonimizar-instalar@` | Instalação opcional do detector de nomes da anonimização de documentos, disparada pela tela Anonimizar |
| `dgclaw-firewall` | Regras de isolamento da rede dos agentes. O instalador força o netavark a usar iptables (`firewall_driver = "iptables"` em `/etc/containers/containers.conf.d`), porque no Ubuntu 26.04 o modo nftables padrão é bloqueado pelo `ufw` e os containers ficam sem internet |
| `caddy` | HTTPS e encaminhamento para o Web (não existe no modo `--proxy-existente`: o HTTPS é do nginx ou túnel que você já tinha) |

O registro `/etc/dgclaw/agentes.json` informa ao Web quais agentes existem e onde ficam seus
serviços. Tokens e senhas não pertencem a esse registro. Os pedidos do primeiro agente ficam
na pasta privada de dados do Web, com permissão restrita, e não expõem logs pela API.

## Identidade, memória e conexões

Os modelos definem identidade e instruções de trabalho em arquivos como `AGENT.md`, `CLAUDE.md`
ou `AGENTS.md`. `MEMORY.md`, `working-memory.md` e `memory/` guardam contexto persistente.
Os componentes de memória usam arquivos e índice local; recursos disponíveis dependem da
configuração do agente e das skills instaladas.

O chat do painel é o canal inicial. Telegram, WhatsApp e outras conexões podem ser configurados
conforme o provedor, a autorização do dono e as credenciais disponíveis. A configuração dessas
conexões não precisa acontecer no terminal da instalação.

## Limites de confiança e verificação

- O Admin tem poderes sobre a VPS. O acesso ao painel deve ficar com seu responsável.
- Os agentes de trabalho ficam separados do Admin e uns dos outros. O isolamento precisa ser
  verificado no ambiente real, além dos testes automatizados.
- Mutações na API exigem autenticação e verificação de origem. Anexos e visuais usam o controle
  de acesso e o sandbox do chat.
- O serviço responder a uma verificação de saúde não prova que a conta do provedor está conectada.
  Por isso a criação inclui o teste de uma resposta real antes de liberar a apresentação final.

O [roteiro de QA](../web/docs/QA-PRIMEIRO-AGENTE.md) cobre instalação, primeiro acesso, criação,
celular e movimento reduzido. Os testes automatizados com dublês não substituem a prova com
Claude Code ou Codex autenticado em uma VPS de teste.
