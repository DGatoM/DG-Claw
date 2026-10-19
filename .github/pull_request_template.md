## O que mudou e por quê

## Como conferir

## Revisão adversarial (Codex)

<!-- Obrigatória antes do merge (docs/REVISAO-ADVERSARIAL.md). Uma linha por ponto apontado:
severidade, arquivo, problema e o que foi feito (corrigido em qual commit, ou recusado e por quê).
Sem segredo e sem dado pessoal. -->

- Rodadas (commit revisado em cada uma):
- Veredito final e commit revisado na rodada limpa:

## Checklist

- [ ] `bash tests/rodar.sh` passa (ou o PR diz o que foi pulado e por quê).
- [ ] Texto novo em português do Brasil, e o erro diz o que fazer.
- [ ] Se o agente precisa conhecer esta feature para usar ou oferecer, ela entrou em `templates/ambiente/agente.md` (e `admin.md`, se o Admin usa). Feature puramente visual que o agente não usa não precisa.
- [ ] Passou pela revisão adversarial do Codex (`docs/REVISAO-ADVERSARIAL.md`) e o resultado está na seção acima.
- [ ] Nenhum segredo, dado pessoal ou caminho de máquina no código, nos testes, nos logs ou neste texto.

## Fora do que o teste cobre

<!-- O que só dá para testar numa máquina de verdade (podman, systemd, rede). -->
