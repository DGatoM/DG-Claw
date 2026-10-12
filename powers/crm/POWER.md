# Poder: crm (CRM / WhatsApp / vendas) — TRAVADO nesta versão

> Status: **não acoplado no v1 do DG Claw.** Aparece travado em `/dgclaw:powers`. Documentação do que
> virá — não tente instalar.

## O que vai fazer
Conectar a pessoa virtual ao **CRM do dono** (ex.: Organizap) e ao **WhatsApp**: ler conversas/clientes/
deals, responder mensagens, ajudar no atendimento e em propostas. Atendimento usa um tom próprio
(profissional), distinto do tom de redes sociais — puxado de um `support-identity` opcional.

## O que vai instalar (quando acoplado)
- Config: `<ws>/.dgclaw/crm.json` (base URL da API, API key com escopos, número/identidade de atendimento).
- Skills de leitura/resposta de conversas e de proposta.
- `powers.py enable crm`.

## Dependências
- API key do CRM do dono (com escopo de leitura e, se for responder, de envio).

## Ativar / desativar (futuro)
- Ativar: `/dgclaw:powers install crm`.
- Desativar: `python3 .../powers.py disable crm` (dados/credenciais preservados).
