# Skill com dado sensível: o padrão da ferramenta fechada

Este é o guia de quem vai criar uma skill que mexe com dado de pessoas (plano de saúde, folha, carteira de clientes). As peças
técnicas estão em `KIT-SENSIVEL.md`.

## A ideia

O agente nunca toca no dado bruto nem na credencial do sistema da empresa. Ele aciona uma **operação com nome e parâmetros**
(`carteira.resumo` com `{"periodo": "2026-09", "agrupar_por": "faixa_etaria"}`) e recebe de volta um resultado agregado,
pseudonimizado e conferido por um verificador de saída.

## Por que só "ensinar a skill a ser cuidadosa" não basta

1. **O transcript guarda tudo o que o script imprime.** Se a skill imprimir um nome no terminal, mesmo para depurar, esse nome
   vai para a Anthropic, para o histórico da conversa, para o índice de busca e para o backup. "Não salvar nada" só funciona
   quando a saída da ferramenta já chega anonimizada ao agente.
2. **Se o agente tem a credencial, a skill é uma sugestão.** Um funcionário curioso ("me mostra o histórico do cliente X") ou
   uma instrução escondida num documento faz o agente consultar o banco direto, sem passar pela skill. A proteção só existe
   quando a credencial fica **fora do container**, no serviço de ferramentas do host.
3. **O DG Claw vira operadora de dado pessoal.** Responde junto com a empresa por falha de segurança dele. Ter registro de quem
   acessou o quê, com que parâmetros e quantos registros, é o que permite à empresa avisar a ANPD a tempo.

## Criar uma ferramenta nova em 5 passos

Cada ferramenta nova leva de 5 a 10 minutos. Os comandos rodam no servidor (como root):

1. **Criar a pasta** a partir do exemplo:
   `dgclaw ferramenta criar folha.resumo --agente rh --responsavel "Maria Souza, maria@empresa.com"`.
   Edite `ferramenta.json` (troque os `PREENCHER`, o esquema dos parâmetros, os campos usados, a retenção) e o `executor.py`
   (a leitura da sua base, sempre com a coluna ou a tabela saindo de uma lista fechada e o valor como parâmetro da consulta).
2. **Gravar a credencial** de um usuário **só de leitura**, restrito a uma visão com os campos necessários:
   `printf 'BASE_URL=...\nBASE_SENHA=...\n' | dgclaw ferramenta credencial folha.resumo`.
3. **Testar** com a base sintética: ajuste o `teste.json` e o `teste/gerar_base.py` ao formato da sua base (nomes e CPFs falsos
   conhecidos) e rode `dgclaw ferramenta testar folha.resumo`. O teste falha se qualquer nome ou CPF da base falsa aparecer na
   saída, se um grupo pequeno não for suprimido ou se o executor "malicioso" não for bloqueado.
4. **Instalar a skill** no agente: `dgclaw ferramenta skill folha.resumo --agente rh`. Ela ensina o agente a usar só a ferramenta
   e a nunca pedir o dado bruto.
5. **Gerar a ficha** do RIPD: `dgclaw ferramenta ficha folha.resumo > ficha-folha-resumo.md`. Finalidade, base legal, campos,
   retenção e responsável. A empresa revisa com o jurídico e arquiva.

## O que a ferramenta devolve

Números agregados. Um grupo com menos de `minimo_grupo` pessoas (10 por padrão) aparece como "menos de 10" e as medidas dele
como "suprimido". Identificadores, quando precisam existir, passam por `pseudonimizar()`. O verificador bloqueia a resposta
inteira se achar CPF, CNPJ, e-mail, telefone, data de nascimento, cartão ou o nome de alguém da base.

## Limites que o cliente precisa ouvir

- **Pseudonimizado ainda é dado pessoal.** Só o anonimizado de verdade (sem volta) sai da LGPD.
- **Agregado com grupo pequeno identifica.** Quem tem uma equipe de 8 pessoas e pede o total por cargo identifica todo mundo.
  O mínimo por grupo ajuda, mas não impede quem cruza consultas; por isso a ferramenta aceita poucos parâmetros.
- **A base legal é da empresa.** Dado de saúde (art. 11) tem base mais restrita. O kit entrega rastreio e contenção, não a
  autorização para tratar.
- **A credencial de leitura precisa ser mínima.** O kit protege o caminho do agente. Se a credencial do banco tiver poder
  demais, o risco passou para o servidor.
