#!/usr/bin/env python3
"""test_thread_log_rollout.py - a conversa de um agente com o motor Codex.

Monta rollouts de mentira num diretorio temporario (formato real: uma linha JSON com
timestamp/type/payload) e confere o que o thread_log.py devolve, e se o inject.py acha o
rollout pelo id da sessao.

    python3 test_thread_log_rollout.py
"""
import json
import os
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import inject  # noqa: E402
import thread_log as tl  # noqa: E402

falhas = []
contados = [0]
SID = "0194aaaa-1111-7222-8333-444455556666"
# o thread_log so le rollout dentro de realpath($HOME): os rollouts de mentira ficam na casa de mentira
CASA_TESTE = tempfile.mkdtemp()
os.environ["HOME"] = CASA_TESTE


def confere(nome, obtido, esperado):
    contados[0] += 1
    if obtido == esperado:
        print(f"  ok {nome}")
    else:
        print(f"  FALHOU {nome}\n      esperado: {esperado!r}\n      obtido:   {obtido!r}")
        falhas.append(nome)


def reg(tipo, payload, ts):
    return {"timestamp": ts, "type": tipo, "payload": payload}


def msg(role, texto, ts, phase=None):
    p = {"type": "message", "role": role,
         "content": [{"type": "output_text" if role == "assistant" else "input_text", "text": texto}]}
    if phase:
        p["phase"] = phase
    return reg("response_item", p, ts)


def dono(m, texto, ts, chat="c_ana"):
    return msg("user", f'<dgchat from="Marta" chat="{chat}" msg="{m}" ts="{ts}">{texto}</dgchat>', ts)


def chamada(tool, args, ts, server="dgchat", status="completed"):
    return reg("event_msg", {"type": "item_completed", "item": {
        "type": "McpToolCall", "server": server, "tool": tool, "arguments": args, "status": status}}, ts)


def evento(tipo, ts):
    return reg("event_msg", {"type": tipo}, ts)


def escrever(linhas, sufixo=SID, bruto_no_fim=""):
    d = tempfile.mkdtemp(dir=CASA_TESTE)
    caminho = os.path.join(d, f"rollout-2026-10-12T15-00-00-{sufixo}.jsonl")
    with open(caminho, "w", encoding="utf-8") as f:
        for o in linhas:
            f.write(json.dumps(o, ensure_ascii=False, separators=(",", ":")) + "\n")
        f.write(bruto_no_fim)
    return caminho


def textos(eventos):
    return [(e["origin"], e["text"]) for e in eventos]


T = "2026-10-12T15:00:"

print("\n1. reply e texto final iguais aparecem uma vez; contexto injetado some")
p = escrever([
    reg("session_meta", {"id": SID, "base_instructions": {"text": "x" * 5000}}, T + "00.000Z"),
    msg("user", "# AGENTS.md instructions for /home/agente\n<INSTRUCTIONS>regras</INSTRUCTIONS>", T + "01.000Z"),
    msg("user", "<environment_context><cwd>/home/agente</cwd></environment_context>", T + "01.100Z"),
    evento("task_started", T + "02.000Z"),
    dono("1", "Oi, tudo bem?", T + "05.000Z"),
    chamada("reply", {"chat": "c_ana", "text": "Tudo certo!"}, T + "06.000Z"),
    msg("assistant", "Tudo certo!", T + "07.000Z", "final_answer"),
    evento("task_complete", T + "07.100Z"),
])
confere("uma vez só", textos(tl.build_thread_log(p)),
        [("owner", "Oi, tudo bem?"), ("persona-direct", "Tudo certo!")])
confere("o rollout é reconhecido pelo nome", tl._is_rollout(p), True)

print("\n2. turno só com texto final: o texto aparece, o commentary não")
p = escrever([
    evento("task_started", T + "00.000Z"),
    dono("1", "Resumo?", T + "05.000Z"),
    msg("assistant", "Vou olhar.", T + "06.000Z", "commentary"),
    msg("assistant", "Tudo em dia.", T + "07.000Z", "final_answer"),
    evento("task_complete", T + "07.100Z"),
])
confere("texto final", textos(tl.build_thread_log(p)), [("owner", "Resumo?"), ("persona-direct", "Tudo em dia.")])

print("\n3. turno em andamento esconde o rascunho; sem sinal nenhum mostra")
p = escrever([evento("task_started", T + "00.000Z"), dono("1", "Oi", T + "05.000Z"),
              msg("assistant", "quase pronto", T + "06.000Z", "final_answer")])
confere("em andamento", textos(tl.build_thread_log(p)), [("owner", "Oi")])
p = escrever([dono("1", "Oi", T + "05.000Z"), msg("assistant", "Olá!", T + "06.000Z")])
confere("sem sinal de turno", textos(tl.build_thread_log(p)), [("owner", "Oi"), ("persona-direct", "Olá!")])
p = escrever([evento("task_started", T + "00.000Z"), dono("1", "A", T + "05.000Z"),
              msg("assistant", "resposta A", T + "06.000Z", "final_answer"), dono("2", "B", T + "07.000Z")])
confere("turno novo fecha o anterior", textos(tl.build_thread_log(p)),
        [("owner", "A"), ("persona-direct", "resposta A"), ("owner", "B")])

print("\n4. send_file, rotina, outro chat, outra tool e entrega que falhou")
p = escrever([
    evento("task_started", T + "00.000Z"),
    dono("1", "Manda", T + "05.000Z"),
    chamada("send_file", {"chat": "c_ana", "path": "/home/agente/out/r.pdf", "caption": "Segue"}, T + "06.000Z"),
    msg("assistant", "Enviei.", T + "07.000Z", "final_answer"),
    evento("task_complete", T + "07.100Z"),
    msg("user", '<plataforma tipo="rotina">resumo diario</plataforma>', T + "10.000Z"),
    chamada("reply", {"chat": "c_ana", "text": "Por conta própria"}, T + "11.000Z"),
    msg("assistant", "Rotina concluida.", T + "12.000Z", "final_answer"),
    evento("task_complete", T + "12.100Z"),
    dono("9", "outro", T + "20.000Z", chat="c_outra"),
    chamada("reply", {"chat": "c_outra", "text": "resp outro"}, T + "21.000Z"),
    dono("2", "Teste", T + "30.000Z"),
    chamada("reply", {"chat": "c_ana", "text": "de outro servidor"}, T + "31.000Z", server="outro"),
    msg("assistant", "Final quatro.", T + "32.000Z", "final_answer"),
    evento("task_complete", T + "32.100Z"),
])
ev = tl.build_thread_log(p, chat="c_ana")
confere("conteúdo e origens", textos(ev), [
    ("owner", "Manda"), ("persona-direct", "Segue"), ("persona-cron", "Por conta própria"),
    ("owner", "Teste"), ("persona-direct", "Final quatro.")])
confere("send_file vira tipo arquivo", (ev[1]["tipo"], ev[1]["arquivo"]), ("arquivo", "/home/agente/out/r.pdf"))
confere("sem --chat o outro chat aparece, com o dono dele",
        "outro" in [e["text"] for e in tl.build_thread_log(p)], True)
p = escrever([dono("1", "Oi", T + "05.000Z"),
              chamada("reply", {"chat": "c_ana", "text": "não saiu"}, T + "06.000Z", status="failed"),
              msg("assistant", "Falei por texto", T + "07.000Z", "final_answer"), evento("task_complete", T + "08.000Z")])
confere("entrega que falhou não conta e o texto final aparece",
        [e["text"] for e in tl.build_thread_log(p)], ["Oi", "Falei por texto"])

print("\n5. linha truncada no fim é ignorada")
p = escrever([evento("task_started", T + "00.000Z"), dono("1", "Oi", T + "05.000Z"),
              chamada("reply", {"chat": "c_ana", "text": "Olá"}, T + "06.000Z")],
             bruto_no_fim='{"timestamp":"2026-10-12T15:00:09.000Z","type":"response_item","payload":{"type":"mess')
confere("sem erro", [e["text"] for e in tl.build_thread_log(p)], ["Oi", "Olá"])
confere("last conta do fim", [e["text"] for e in tl.build_thread_log(p, last=1)], ["Olá"])

print("\n6. o inject.py acha o rollout pelo id da sessão")
casa = Path(tempfile.mkdtemp())
os.environ["HOME"] = str(casa)
os.environ.pop("CODEX_HOME", None)
confere("sem nenhum rollout", inject.find_codex_rollout(SID), None)
pasta = casa / ".codex" / "sessions" / "2026" / "10" / "12"
pasta.mkdir(parents=True)
arq = pasta / f"rollout-2026-10-12T15-00-00-{SID}.jsonl"
arq.write_text("{}\n")
confere("assinatura: ~/.codex", inject.find_codex_rollout(SID), str(arq))
api = casa / ".plataforma" / "codex-api" / "ana" / "sessions" / "2026" / "10" / "12"
api.mkdir(parents=True)
arq_api = api / f"rollout-2026-10-12T15-00-00-{SID}.jsonl"
arq_api.write_text("{}\n")
confere("api: a pasta por sessão vem primeiro", inject.find_codex_rollout(SID), str(arq_api))
confere("codexHome informado pelo runner dentro da casa",
        inject.find_codex_rollout(SID, str(casa / ".codex")), str(arq))
confere("codexHome fora da casa é ignorado (cai na busca normal)",
        inject.find_codex_rollout(SID, "/etc"), str(arq_api))
confere("id que não parece de sessão", inject.find_codex_rollout("../../x"), None)
confere("id vazio", inject.find_codex_rollout(""), None)

print("\n7. atalho (symlink) não fura a casa")
fora = Path(tempfile.mkdtemp())
alvo = fora / "segredo.jsonl"
alvo.write_text(json.dumps({"timestamp": "2026-10-12T15:00:00.000Z", "type": "response_item", "payload": {"type": "message", "role": "user", "content": [{"type": "input_text", "text": '<dgchat from="M" chat="c_ana" msg="1" ts="x">VAZOU</dgchat>'}]}}) + "\n")
casa2 = Path(tempfile.mkdtemp())
os.environ["HOME"] = str(casa2)
pasta2 = casa2 / ".codex" / "sessions" / "2026" / "10" / "12"
pasta2.mkdir(parents=True)
atalho = pasta2 / f"rollout-2026-10-12T15-00-00-{SID}.jsonl"
atalho.symlink_to(alvo)
confere("rollout atalho para arquivo de fora: find recusa", inject.find_codex_rollout(SID), None)
confere("rollout atalho para arquivo de fora: thread_log não lê", tl.build_thread_log(str(atalho)), [])
atalho.unlink()
(casa2 / ".codex" / "sessions").rename(casa2 / ".codex" / "sessions_real")
(casa2 / ".codex" / "sessions").symlink_to(fora)
(fora / "2026" / "10" / "12").mkdir(parents=True)
(fora / "2026" / "10" / "12" / f"rollout-2026-10-12T15-00-00-{SID}.jsonl").write_text("{}\n")
confere(".codex/sessions atalho para pasta de fora: recusado", inject.find_codex_rollout(SID), None)
(casa2 / ".codex" / "sessions").unlink()
(casa2 / ".codex" / "sessions_real").rename(casa2 / ".codex" / "sessions")
guardado = casa2 / "guardado"
guardado.mkdir()
interno = guardado / f"rollout-2026-10-12T15-00-00-{SID}.jsonl"
interno.write_text("{}\n")
(casa2 / ".codex" / "sessions" / "2026" / "10" / "12" / interno.name).symlink_to(interno)
confere("atalho dentro da casa é aceito", inject.find_codex_rollout(SID), str(interno.resolve()))

print(f"\n{contados[0] - len(falhas)}/{contados[0]} verdes.")
if falhas:
    print("REPROVADO: " + ", ".join(falhas))
    sys.exit(1)
print("APROVADO")
