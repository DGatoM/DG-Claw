# Política de segurança

## Como relatar uma vulnerabilidade

Use o botão **Report a vulnerability**, na aba **Security** deste repositório no GitHub
(https://github.com/DGatoM/DG-Claw/security/advisories/new). O relato chega em privado só para quem
mantém o projeto.

**Não abra issue pública** para falhas de segurança. Uma issue pública avisa todo mundo antes de
existir correção.

No relato, mande:

- uma descrição do problema e do que ele permite fazer;
- os passos para reproduzir, do começo ao fim;
- a versão do DG Claw e o sistema do servidor (por exemplo, Ubuntu 24.04);
- a saída de `dgclaw status`, sem senhas, chaves ou tokens;
- se já sabe como corrigir, a sugestão.

Tentamos responder em até 7 dias corridos. É uma intenção de boa-fé, não um acordo de
nível de serviço: o projeto é mantido por poucas pessoas. Quando a falha se confirmar, combinamos
com você a correção e a data de divulgação, e damos o crédito a quem quiser aparecer.

## Escopo

**Dentro do escopo:**

- o instalador (`install.sh`) e a CLI `bin/dgclaw`;
- o DG Claw Web (login, sessões, chat) e o painel;
- o runner, que mantém a sessão de cada agente viva;
- a imagem dos containers e o isolamento entre os agentes, e entre eles e o servidor;
- o cofre de chaves de cada agente e as chaves de API do painel.

**Fora do escopo:**

- a conta do Claude ou do Codex da pessoa e as regras de uso desses serviços (veja
  [docs/RISCO-DE-BLOQUEIO-DE-CONTA.md](docs/RISCO-DE-BLOQUEIO-DE-CONTA.md));
- o provedor do servidor (VPS) e a segurança da máquina fora do que o DG Claw instala;
- configurações que a própria pessoa alterou, como liberar o envio de e-mail pelo agente ou abrir
  portas no firewall;
- o plugin antigo do Claude Code (versão 0.x), que a v1 substituiu e que não faz parte deste
  repositório. Ele não recebe mais correções de segurança: quem usa deve migrar para a v1.

## Versões suportadas

| Versão | Recebe correções de segurança |
| --- | --- |
| 1.x | sim |
| 0.x (plugin antigo) | não; migre para a v1 |

## Para saber mais

- [docs/SEGURANCA.md](docs/SEGURANCA.md): o modelo de ameaça, o que o DG Claw protege, como e o que
  ainda não protege.
- [docs/RISCO-DE-BLOQUEIO-DE-CONTA.md](docs/RISCO-DE-BLOQUEIO-DE-CONTA.md): por que usar o DG Claw
  com a sua assinatura do Claude ou da OpenAI não infringe as regras dessas empresas, e as fontes.
