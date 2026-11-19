// Registro dos motores: do nome do catálogo (`claude`, `codex`, `opencode`) ao objeto que sabe subir o CLI.
import { motorClaude } from "./claude.js";
import { motorCodex } from "./codex.js";
import type { NomeProvedor } from "./escolha.js";
import type { Motor } from "./motor.js";
import { motorOpenCode } from "./opencode.js";

export function motorDe(provedor: NomeProvedor): Motor {
  if (provedor === "opencode") return motorOpenCode;
  return provedor === "codex" ? motorCodex : motorClaude;
}
