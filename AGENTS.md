# DG Claw: estrutura do repositório

O DG Claw instala um painel web com chat, um Admin e a infraestrutura para agentes de trabalho
em containers separados. O [README](README.md) apresenta o produto e o [INSTALAR.md](INSTALAR.md)
contém o procedimento de instalação.

## Componentes

| Caminho | Conteúdo |
| --- | --- |
| `install.sh`, `lib/` | Instalador e funções de administração |
| `bin/dgclaw` | CLI de administração dos agentes |
| `runner/` | Execução de sessões Claude Code e Codex |
| `web/` | Interface web, autenticação e chat |
| `panel/` | Configurações e recursos de cada agente |
| `container/` | Imagem dos agentes |
| `templates/` | Arquivos iniciais do Admin e dos agentes |
| `skills/` | Recursos e roteiros dos agentes |
| `docs/` | Documentação do produto |
| `tests/` | Testes automatizados |

A [arquitetura](docs/ARQUITETURA.md) descreve o funcionamento e os limites entre os componentes.
`tests/rodar.sh` executa as baterias automatizadas. Os testes do instalador usam uma raiz temporária
(`DGCLAW_RAIZ`) e substitutos dos comandos do sistema. A prova de instalação completa usa uma VPS
de teste separada, conforme o [roteiro de QA](web/docs/QA-PRIMEIRO-AGENTE.md).

## Regras do projeto

- **Atualizar nunca apaga configuração do usuário.** Rodar o `install.sh` de novo, atualizar a
  versão ou reconstruir a imagem tem que preservar tudo o que a pessoa já configurou: chaves
  (`GROQ_API_KEY`, `ELEVENLABS_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY` e qualquer outra),
  opções do `web.env`, cofre, agentes, memória e conversas. Arquivo de configuração que já existe
  se edita linha a linha (troca só as linhas que o instalador controla e mantém o resto, na ordem);
  nunca se reescreve inteiro. Todo código novo que grava em arquivo de configuração vem com um
  teste que monta o arquivo com uma linha alheia e confere que ela sobreviveu.
  *Por quê:* em 17/10/2026 o instalador regravava o `web.env` só com o usuário e a senha do
  painel, e cada atualização desligava o microfone dos agentes. O Admin percebeu antes de aplicar.
