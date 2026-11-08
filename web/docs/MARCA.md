# Marca (white label)

O DG Claw Web lê a marca de uma pasta que fica fora da instalação e sobrevive às atualizações:
`/etc/dgclaw/marca/` (ou a pasta indicada em `DGCLAW_MARCA_DIR`). Dentro dela vai o arquivo `marca.json` e os
arquivos que ele cita (logo, favicon, ícone do app, fontes), todos na mesma pasta. O Web só lê essa pasta: nunca grava nela.
Sem a pasta, vale o padrão de fábrica (`web/marca-padrao.json` e `web/public/ds/marca-padrao/`).

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
  "cores": { "botao-fundo": "#D32F2F", "botao-texto": "#FFFFFF" },
  "cores_escuro": { "cor-fundo": "#101418" },
  "fontes": { "base": { "familia": "Inter", "arquivo": "inter.woff2" }, "mono": { "familia": "Fira Code", "arquivo": "fira.woff2" } }
}
```

- **Textos** (`nome`, `nome_curto`, `slogan`, `titulo_login`): sem `<`, sem `>` e sem quebra de linha; até 60, 30, 140 e 120 caracteres.
- **Arquivos**: só o nome (sem pasta), letras, números, ponto, hífen e sublinhado. Logo em svg, png, webp ou jpg (até 512 KB);
  favicon em png (até 256 KB); ícone do app em png quadrado de pelo menos 192 px (até 2 MB); fonte em woff2 (até 1,5 MB).
  Atalhos (link simbólico) são recusados. O logo svg só é exibido como imagem, isolado (sem script).
- **Cores**: `#RRGGBB`. Nomes aceitos: `cor-fundo`, `cor-superficie`, `cor-texto`, `cor-texto-2`, `cor-borda`, `cor-acento`,
  `cor-sobre-acento`, `cor-link`, `cor-perigo`, `cor-sucesso`, `cor-aviso`, `botao-fundo`, `botao-texto`, `botao-borda`,
  `botao2-fundo`, `botao2-texto`, `campo-fundo`, `campo-texto`, `campo-borda`, `cartao-fundo`, `cartao-borda`, `login-fundo`,
  `login-pontos`, `logo-no`, `logo-centro`, `conversa-fundo`, `balao-meu-fundo`, `balao-meu-texto`, `balao-agente-fundo`, `balao-agente-texto`.
- **Campo inválido**: só aquele campo volta ao padrão, e o log do Web explica o que falhou, com o valor recebido e o que fazer.
- A mudança vale sem reiniciar: o Web confere a data dos arquivos a cada pedido.

Rotas públicas (sem sessão, porque a tela de login precisa delas): `/marca.css`, `/marca/logo`, `/marca/favicon`,
`/marca/icone-app`, `/marca/fonte/base`, `/marca/fonte/mono` e `/manifest.webmanifest`.
