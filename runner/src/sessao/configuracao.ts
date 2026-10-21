import fs from "node:fs";
import path from "node:path";
import type { Sessao } from "../sessao.js";
import { randomBytes } from "node:crypto";
import { HOOK_HANDLER_SOURCE } from "../hook-handler-source.js";
import { log } from "../logger.js";
import { USO_HANDLER_SOURCE } from "../uso-handler-source.js";
import { type ResultadoDoAmbiente, montarAmbiente, nomesDoCofre } from "../provedores/ambiente.js";
import { lerCanais, pastaTelegramDesligado } from "../provedores/canais.js";
import type { Catalogo } from "../provedores/catalogo.js";
import type { Escolha, EscolhaEfetiva } from "../provedores/escolha.js";
import type { CtxMotor } from "../provedores/motor.js";
import { spawn, subir } from "./ciclo.js";

export function montarAmbienteBase(s: Sessao, escolha: Escolha, catalogo: Catalogo): ResultadoDoAmbiente {
  const cfg = s.descritor.config;
  const amb = montarAmbiente({
    base: process.env,
    envExtra: cfg.envExtra,
    provedor: escolha.provedor,
    auth: escolha.auth,
    catalogo,
    cofre: nomesDoCofre(),
  });
  // O que destrava o modo "não pergunte nada" quando o processo é root.
  //
  // O runner roda como root, e o Claude Code recusa QUALQUER forma de pular permissão
  // sob root com "cannot be used with root/sudo privileges for security
  // reasons". Ele não pede nada e não espera: sai com código 1 em segundos, e
  // como quem morre é o PTY e não o serviço, o `Restart=always` da unidade não
  // pega. O agente some sem ninguém entender por quê (custou um agente de cliente fora do ar
  // em 24/08/2026, no primeiro agente em que isto foi ligado).
  //
  // `IS_SANDBOX=1` é a saída que o próprio CLI oferece, e já era o padrão desta
  // casa antes deste arquivo existir. Só entra no modo bypass, de propósito: num
  // agente que ainda pergunta, esta variável não muda nada. O Codex não precisa
  // dela (aceita o flag de bypass como root; testado em 12/10/2026).
  if (escolha.provedor === "claude" && cfg.permissionMode === "bypassPermissions") amb.env.IS_SANDBOX = "1";
  return amb;
}

/** Monta o contexto de um spawn: ambiente por modo, canal Telegram, identidade e hooks. */
export function montarCtx(s: Sessao, escolha: EscolhaEfetiva, catalogo: Catalogo): CtxMotor {
  const cfg = s.descritor.config;
  const amb = montarAmbienteBase(s, escolha, catalogo);
  // Só os NOMES vão para o log, nunca os valores.
  if (amb.aplicadas.length) log.info(s.a("env"), `envExtra aplicado: ${amb.aplicadas.join(", ")}`);
  if (amb.recusadas.length) {
    log.erro(
      s.a("env"),
      `envExtra recusado: ${amb.recusadas.join(", ")}`,
      "nome de variável inválido ou valor que não é texto; corrigir config.envExtra no descritor",
    );
  }
  if (amb.removidas.length) {
    log.info(
      s.a("env"),
      `fora do ambiente (${escolha.provedor}/${escolha.auth}): ` + amb.removidas.map((r) => `${r.nome} (${r.motivo})`).join(", "),
    );
  }

  const env = amb.env;
  const principal = s.papel === "principal";
  let canalTelegram = false;
  // Um agente antigo que já declara `--channels` no extraArgs continua do jeito dele:
  // tirar o TELEGRAM_BOT_TOKEN dele derrubaria um canal que funciona.
  const canalLegado = principal && (cfg.extraArgs ?? []).includes("--channels");
  if (!canalLegado) {
    const canais = principal ? lerCanais(cfg.cwd) : null;
    if (principal && escolha.provedor === "claude" && canais?.telegram.ligado && canais.telegram.estadoDir) {
      env.TELEGRAM_STATE_DIR = canais.telegram.estadoDir;
      canalTelegram = true;
    } else {
      // O plugin faz polling mesmo sem `--channels`. Sem isto uma sessão paralela
      // (ou um Codex) consumiria as mensagens do bot e as jogaria fora.
      delete env.TELEGRAM_BOT_TOKEN;
      env.TELEGRAM_STATE_DIR = pastaTelegramDesligado(cfg.cwd);
      if (principal && escolha.provedor === "codex" && canais?.telegram.ligado) {
        log.aviso(
          s.a("canais"),
          "o canal do Telegram está ligado para este agente, mas o Telegram oficial só existe no Claude; " +
            "com o Codex como provedor o agente conversa pelo painel",
        );
      }
    }
  }

  const nonce = randomBytes(32).toString("hex");
  s.nonce = nonce;
  const identidade = montarIdentidade(s);
  const settings = s.motor.usaHooks ? escreverSettings(s, nonce) : null;

  return {
    id: s.descritor.id,
    slug: s.descritor.slug,
    papel: s.papel,
    porta: s.porta,
    cwd: cfg.cwd,
    config: cfg,
    escolha: { provedor: escolha.provedor, auth: escolha.auth, modelo: escolha.modelo },
    catalogo,
    env,
    chaveDoModoPresente: amb.chaveDoModoPresente,
    variavelDoModo: amb.variavelDoModo,
    pastaDeHooks: pastaDeHooks(s),
    pastaDeEstado: s.pastaDeEstado,
    identidade,
    settings,
    nonce,
    canalTelegram,
    novoId: null,
    extrasDoMotor: [],
    limpezas: [],
    a: (area) => s.a(area),
  };
}

/** Um contexto sem efeito colateral, para perguntar "tem login?" antes de qualquer spawn. */
export function ctxLeve(s: Sessao): CtxMotor {
  const { escolha, catalogo } = s.lerEscolha();
  const amb = montarAmbienteBase(s, escolha, catalogo);
  const cfg = s.descritor.config;
  return {
    id: s.descritor.id,
    slug: s.descritor.slug,
    papel: s.papel,
    porta: s.porta,
    cwd: cfg.cwd,
    config: cfg,
    escolha: { provedor: escolha.provedor, auth: escolha.auth, modelo: escolha.modelo },
    catalogo,
    env: amb.env,
    chaveDoModoPresente: amb.chaveDoModoPresente,
    variavelDoModo: amb.variavelDoModo,
    pastaDeHooks: pastaDeHooks(s),
    pastaDeEstado: s.pastaDeEstado,
    identidade: { arquivo: null, texto: null },
    settings: null,
    nonce: "",
    canalTelegram: false,
    novoId: null,
    extrasDoMotor: [],
    limpezas: [],
    a: (area) => s.a(area),
  };
}

export function pastaDeHooks(s: Sessao): string {
  // Dentro da pasta de ESTADO (que é gravável), e não ao lado do descritor (que no
  // container é só leitura) nem em /tmp: um settings apagado pela limpeza de /tmp
  // deixaria o agente sem hook de status no meio da vida, e o sintoma seria um
  // agente eternamente "trabalhando".
  return path.join(s.pastaDeEstado, "runner-hooks");
}

/** O descritor pode declarar um statusLine próprio; aí o medidor não entra. O settings do usuário
 *  e o do projeto não contam: conferido em 19/10/2026 com o Claude Code 2.1.304, o `--settings` do
 *  spawn ganha deles, e o terminal do agente nem aparece para ninguém. Recuar por causa deles só
 *  deixaria o Status em "sem dado" sem motivo. */
function statusLineDeOutroDono(s: Sessao): string | null {
  return s.descritor.config.statusLine ? "campo statusLine do descritor" : null;
}

export function escreverSettings(s: Sessao, nonce: string): string | null {
  try {
    const dir = pastaDeHooks(s);
    fs.mkdirSync(dir, { recursive: true });
    const handler = path.join(dir, "runner-hook.mjs");
    const atual = fs.existsSync(handler) ? fs.readFileSync(handler, "utf8") : "";
    if (atual !== HOOK_HANDLER_SOURCE) fs.writeFileSync(handler, HOOK_HANDLER_SOURCE, "utf8");

    const cfg = s.descritor.config;
    const base = `"${process.execPath}" "${handler}" --agent ${s.descritor.id} --port ${s.porta} --nonce ${nonce}`;
    const para = (ev: string, matcher = "") => [
      { matcher, hooks: [{ type: "command", command: `${base} --event ${ev}` }] },
    ];
    const stop = [{ type: "command", command: `${base} --event Stop` }];
    for (const extra of cfg.stopHooks ?? []) {
      if (typeof extra === "string" && extra.trim()) {
        stop.push({ type: "command", command: extra.trim() });
      } else {
        log.erro(
          s.a("hook"),
          `stopHooks tem um item que não é texto: ${JSON.stringify(extra)}`,
          "corrigir stopHooks no descritor do agente; sem a trava de fim de turno o canal " +
            "escreve a resposta como texto e quem está do outro lado vê uma janela muda",
        );
      }
    }
    // O hook do runner vem sempre primeiro; os promptHooks só entram quando
    // existem, e sem eles o settings fica idêntico ao de antes.
    const prompt = para("UserPromptSubmit");
    for (const extra of s.promptHooks) {
      if (typeof extra === "string" && extra.trim()) {
        prompt[0].hooks.push({ type: "command", command: extra.trim() });
      } else {
        log.erro(
          s.a("hook"),
          `promptHooks tem um item que não é texto: ${JSON.stringify(extra)}`,
          "corrigir promptHooks no descritor; o comando é ignorado e o resto dos hooks segue",
        );
      }
    }
    const settings: Record<string, unknown> = {
      hooks: {
        SessionStart: para("SessionStart"),
        UserPromptSubmit: prompt,
        PreToolUse: para("PreToolUse"),
        Notification: para("Notification", "permission_prompt"),
        // Só a ferramenta de pergunta: a resposta da pessoa é o que tira o agente de waiting_input.
        PostToolUse: para("PostToolUse", "AskUserQuestion"),
        PreCompact: para("PreCompact"),
        Stop: [{ matcher: "", hooks: stop }],
        StopFailure: para("StopFailure"),
      },
    };
    if (s.motor.provedor === "claude") {
      const dono = statusLineDeOutroDono(s);
      if (dono) {
        log.aviso(
          s.a("uso"),
          `o agente já tem um statusLine próprio (${dono}); não instalei o medidor de uso da assinatura, ` +
            `então o Status do painel vai mostrar "sem dado". Para medir, tire o statusLine de lá`,
        );
      } else {
        // O medidor é opcional: falha aqui desliga só o statusLine. Deixar a exceção subir derrubaria
        // o settings inteiro, e o agente nasceria sem as regras de permissão (revisão adversarial, PR #58).
        const usoHandler = path.join(dir, "runner-uso.mjs");
        try {
          const usoAtual = fs.existsSync(usoHandler) ? fs.readFileSync(usoHandler, "utf8") : "";
          if (usoAtual !== USO_HANDLER_SOURCE) fs.writeFileSync(usoHandler, USO_HANDLER_SOURCE, "utf8");
          settings.statusLine = {
            type: "command",
            command: `"${process.execPath}" "${usoHandler}" --agent ${s.descritor.id} --port ${s.porta} --nonce ${nonce}`,
          };
        } catch (err) {
          log.erro(
            s.a("uso"),
            `não consegui preparar ${usoHandler}: ${err instanceof Error ? err.message : err}`,
            `o agente sobe normalmente, com as regras de permissão, mas sem o medidor de uso ` +
              `(o Status mostra "sem dado"). Conferir se esse caminho é um arquivo gravável e reiniciar o agente`,
          );
        }
      }
    }
    const limpar = (r?: string[] | null) =>
      (r ?? []).filter((x) => typeof x === "string" && x.trim()).map((x) => x.trim());
    const allow = limpar(cfg.allowTools);
    const ask = limpar(cfg.askTools);
    const deny = limpar(cfg.denyTools);
    if (allow.length || ask.length || deny.length) {
      settings.permissions = {
        ...(deny.length ? { deny } : {}),
        ...(ask.length ? { ask } : {}),
        ...(allow.length ? { allow } : {}),
      };
    }
    // 16/10/2026: o Claude Code 2.x, em bypassPermissions, abre um diálogo interativo
    // ("WARNING: Bypass Permissions mode ... 1. No, exit / 2. Yes, I accept") a cada boot.
    // O Enter que o runner manda para soltar a fila escolhe o padrão, "No, exit", e o
    // CLI sai com código 1 em loop. `bypassPermissionsModeAccepted` no ~/.claude.json
    // não resolve; esta chave resolve.
    if (s.motor.provedor === "claude" && cfg.permissionMode === "bypassPermissions") {
      settings.skipDangerousModePermissionPrompt = true;
    }
    const arquivo = path.join(dir, `${s.descritor.id}.settings.json`);
    // Modo 600: o nonce está dentro do comando de cada hook.
    fs.writeFileSync(arquivo, JSON.stringify(settings), { encoding: "utf8", mode: 0o600 });
    log.info(s.a("hook"), `settings escrito (${allow.length} allow, ${ask.length} ask, ${deny.length} deny)`);
    return arquivo;
  } catch (err) {
    log.erro(
      s.a("hook"),
      `não consegui escrever o settings de hooks: ${err instanceof Error ? err.message : err}`,
      `o agente vai subir SEM status determinístico e SEM as regras de permissão do ` +
        `descritor, o que é mais permissivo do que o desenhado: conferir permissão de ` +
        `escrita em ${pastaDeHooks(s)} e reiniciar o serviço`,
    );
    return null;
  }
}

/** Junta os arquivos de identidade da sessão num só, a cada spawn (o dono pode ter
 *  editado um deles entre uma subida e outra). Na principal entra o
 *  `config.identidadeArquivo`; na paralela, a lista `identidade` dela (a persona da
 *  principal não se herda). Arquivo que falta é registrado e os outros seguem: uma
 *  persona incompleta ainda é melhor que uma sessão que nem sobe. */
export function montarIdentidade(s: Sessao): { arquivo: string | null; texto: string | null } {
  const relativos = [
    ...(s.papel === "principal" && s.descritor.config.identidadeArquivo?.trim()
      ? [s.descritor.config.identidadeArquivo.trim()]
      : []),
    ...s.identidade,
  ];
  if (!relativos.length) return { arquivo: null, texto: null };
  const partes: string[] = [];
  for (const rel of relativos) {
    const caminho = path.resolve(s.descritor.config.cwd, rel);
    try {
      partes.push(fs.readFileSync(caminho, "utf8").trim());
    } catch (err) {
      log.erro(
        s.a("spawn"),
        `não consegui ler o arquivo de identidade ${caminho}: ${err instanceof Error ? err.message : err}`,
        "conferir o caminho em identidade/identidadeArquivo no descritor (relativo à casa do agente); a sessão sobe sem esse trecho",
      );
    }
  }
  if (!partes.length) return { arquivo: null, texto: null };
  const texto = partes.join("\n\n---\n\n");
  try {
    const dir = pastaDeHooks(s);
    fs.mkdirSync(dir, { recursive: true });
    const arquivo = path.join(dir, `${s.descritor.id}.identidade.md`);
    fs.writeFileSync(arquivo, texto, "utf8");
    return { arquivo, texto };
  } catch (err) {
    log.erro(
      s.a("spawn"),
      `não consegui gravar a identidade concatenada: ${err instanceof Error ? err.message : err}`,
      `conferir permissão de escrita em ${pastaDeHooks(s)}; a sessão sobe sem a identidade`,
    );
    return { arquivo: null, texto: null };
  }
}
