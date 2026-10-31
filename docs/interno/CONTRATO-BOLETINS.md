# Contrato: seguranca/boletins.json (repositório do DG Claw), versão 2

Quem escreve: `ronda.py boletim publicar <id> --aprovado-por-danilo` (repo ronda-seguranca), via PR que o Danilo aprova.
Quem lê: o DG Claw instalado no cliente (painel web).

```json
{"versao": 2, "boletins": [{
  "id": "GHSA-332P-7HRC-92WF",              // ^[A-Z0-9][A-Z0-9._-]{2,60}$
  "relacionados": ["GHSA-5X8W-8JJ5-Q52H"],   // lista (0 a 20) de outros ids cobertos pelo mesmo boletim, mesmo formato
  "severidade": "CRITICAL",                  // CRITICAL | HIGH | MEDIUM | LOW | desconhecida
  "componente": "Pillow",                    // nome da ferramenta, até 80, sem caractere de controle
  "acao": "atualizar-dgclaw",                // atualizar-dgclaw | atualizar-sistema | parar-servico | aguardar
  "titulo": "Vulnerabilidade no Pillow",     // até 120
  "detalhe": "texto do aviso ...",           // até 600, pode ter \n
  "o_que_muda": "A imagem dos agentes passa a usar o Pillow 13.0.0, que fecha as falhas.", // até 400
  "publicado_em": "2026-10-21T21:28:09Z",    // ISO: quando a FALHA foi publicada pela fonte oficial
  "boletim_em": "2026-10-31T10:00:00Z",      // ISO: quando o boletim foi preparado
  "fonte_url": "https://github.com/advisories/GHSA-332p-7hrc-92wf", // obrigatório, https://, até 300: advisory oficial ou da distro
  "noticia_url": null                         // opcional (null ou https://, até 300): post/notícia que repercutiu
}]}
```

Regras:
- `versao` 1 (formato antigo, sem relacionados/o_que_muda/boletim_em/fonte_url/noticia_url) continua sendo lido; boletim sem `fonte_url` válido é DESCARTADO pelo leitor, com log explicando (nada de alerta sem fonte).
- Campos desconhecidos são ignorados pelo leitor (compatibilidade para frente); o escritor só emite os campos acima.
- Um boletim está "pendente" numa instalação quando o seu `id` está no boletins.json publicado na `main` e NÃO está no `seguranca/boletins.json` da versão instalada (`/opt/dgclaw/app/seguranca/boletins.json`). Isso só resolve boletins com `acao: "atualizar-dgclaw"`: o boletim só é publicado depois que a correção entrou na `main`, então atualizar o DG Claw some com o aviso. Para `atualizar-sistema`, `parar-servico` e `aguardar`, estar na versão instalada não prova nada: o boletim segue pendente até a ronda local (`ronda.json`, `ja_tratadas`) listar o id ou um relacionado como corrigido ou aplicado, ou até o dono/Admin dispensar pela API (`atualizar-sistema` exige `{"confirmo": "aplicado"}`).
