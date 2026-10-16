// Registro dos motores: do nome do catálogo (`claude`, `codex`) ao objeto que sabe subir o CLI.
import { motorClaude } from "./claude.js";
import { motorCodex } from "./codex.js";
import type { NomeProvedor } from "./escolha.js";
import type { Motor } from "./motor.js";

export function motorDe(provedor: NomeProvedor): Motor {
  return provedor === "codex" ? motorCodex : motorClaude;
}
