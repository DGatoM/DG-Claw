# Marca própria (white label)

Uma empresa pode usar o DG Claw com o próprio nome, logo, favicon, cores e fontes, sem mexer no código e sem perder nada
na próxima atualização. Tudo fica em uma pasta fora da instalação, `/etc/dgclaw/marca/`, que o instalador cria quando ela
falta e nunca apaga, recria ou esvazia. Quem quiser conhecer os valores de cor e de tipografia por trás do visual lê o
[DESIGN-SYSTEM.md](DESIGN-SYSTEM.md).

O Web só lê essa pasta, nunca grava nela. A mudança vale sem reiniciar nada: o Web confere a data dos arquivos a cada
pedido. Sem a pasta (ou sem o `marca.json`), vale o padrão de fábrica.

## Passo a passo

1. **Entre no servidor** (ou peça ao Admin, que sabe fazer este passo pelo painel) e abra a pasta:

   ```bash
   cd /etc/dgclaw/marca
   ```

2. **Coloque os arquivos da marca nessa pasta**, todos juntos, sem subpastas:

   | O que | Formato | Limite |
   | --- | --- | --- |
   | Logo | `svg`, `png`, `webp` ou `jpg` | 512 KB |
   | Favicon (ícone da aba do navegador) | `png` | 256 KB |
   | Ícone do app (tela de início do celular) | `png` quadrado, no mínimo 192 por 192 px | 2 MB |
   | Fonte | `woff2` | 1,5 MB cada |

3. **Crie o `marca.json`** na mesma pasta, dizendo o nome e quais arquivos usar:

   ```json
   {
     "nome": "Acme Bot",
     "nome_curto": "Acme",
     "slogan": "Seus agentes, do seu jeito.",
     "titulo_login": "Entre no Acme Bot.",
     "logo": "logo.png",
     "logo_tem_nome": false,
     "favicon": "favicon.png",
     "icone_app": "icone-512.png",
     "tema": "claro",
     "cores": { "botao-fundo": "#D32F2F", "botao-texto": "#FFFFFF", "cor-acento": "#D32F2F" },
     "cores_escuro": { "cor-fundo": "#101418" },
     "fontes": {
       "base": { "familia": "Inter", "arquivo": "inter.woff2" },
       "mono": { "familia": "Fira Code", "arquivo": "fira.woff2" }
     }
   }
   ```

4. **Confira** (veja a seção "Como conferir").

Os campos são todos opcionais. O que você não escrever fica com o valor de fábrica.

## O que cada campo faz

- **Textos** (`nome`, `nome_curto`, `slogan`, `titulo_login`): até 60, 30, 140 e 120 caracteres, sem `<`, sem `>` e sem quebra
  de linha. O `nome` aparece no título das abas, no cabeçalho, na tela de login, no painel dos agentes e no app instalado.
- **Logo**: aparece na tela de login e no indicador de carregamento. Se a imagem já traz o nome da empresa escrito, ponha
  `"logo_tem_nome": true` e o nome em texto deixa de aparecer ao lado (continua disponível para leitores de tela).
  Um logo `svg` é exibido só como imagem, isolado, sem executar script.
- **Favicon** e **ícone do app**: o primeiro vai na aba do navegador, o segundo na tela de início do celular.
- **Tema**: `"claro"` (padrão) ou `"escuro"`.
- **Cores**: no formato `#RRGGBB`. Os nomes aceitos são `cor-fundo`, `cor-superficie`, `cor-texto`, `cor-texto-2`,
  `cor-borda`, `cor-acento`, `cor-sobre-acento`, `cor-link`, `cor-perigo`, `cor-sucesso`, `cor-aviso`, `botao-fundo`,
  `botao-texto`, `botao-borda`, `botao2-fundo`, `botao2-texto`, `campo-fundo`, `campo-texto`, `campo-borda`, `cartao-fundo`,
  `cartao-borda`, `login-fundo`, `login-pontos`, `logo-no`, `logo-centro`, `conversa-fundo`, `balao-meu-fundo`,
  `balao-meu-texto`, `balao-agente-fundo` e `balao-agente-texto`. O bloco `cores_escuro` vale só no tema escuro.
- **Fontes**: `base` (texto corrido) e `mono` (código). Cada uma leva o nome da família e o arquivo `woff2`.

Algumas receitas:

- Mudar todos os botões: `botao-fundo` e `botao-texto`.
- Mudar o destaque do sistema inteiro (foco, abas ativas): `cor-acento` e `cor-sobre-acento`. Garanta contraste: texto claro
  sobre um acento escuro, texto escuro sobre um acento claro.
- Fundo azul na conversa: `"conversa-fundo": "#DCEBFA"`.

## Regras de segurança dos arquivos

- Só o nome do arquivo, sem pasta: letras, números, ponto, hífen e sublinhado.
- Atalhos (link simbólico) são recusados.
- Um campo inválido volta sozinho ao valor de fábrica, e só ele. Os outros continuam valendo.

## Como conferir

1. Abra a tela de login numa janela anônima. Ela mostra o nome, o logo e as cores novas.
2. Confira os endereços públicos da marca no navegador: `/marca.css` (as cores e fontes), `/manifest.webmanifest` (nome e
   ícone do app), `/marca/logo`, `/marca/favicon` e `/marca/icone-app`.
3. Se algum campo foi recusado, o log do Web diz qual, com o valor recebido e o que fazer:

   ```bash
   journalctl -u dgclaw-web --since "10 minutes ago" | grep -i marca
   ```

4. No celular, o ícone do app instalado só muda depois de remover o atalho e adicionar de novo à tela de início.

Rotas públicas (sem sessão, porque a tela de login precisa delas): `/marca.css`, `/marca/logo`, `/marca/favicon`,
`/marca/icone-app`, `/marca/fonte/base`, `/marca/fonte/mono` e `/manifest.webmanifest`.

## Atualizar e reinstalar

`dgclaw atualizar` e `./install.sh` não tocam em `/etc/dgclaw/marca/`. A pasta entra no backup (`dgclaw backup`) junto com o
resto de `/etc/dgclaw`.
