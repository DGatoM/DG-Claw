# QA do primeiro agente pelo painel


Registrar hash, máquina, horário, navegador e resultado de cada linha. Não executar na VPS principal.

- [ ] Começar com VPS Ubuntu limpa, Claude Code instalado e login de assinatura feito pelo dono.
- [ ] Executar os três comandos do INSTALL.md. Conferir endereço do painel, usuário e link de primeiro acesso na saída (sem senha). Abrir o link, cadastrar a senha e cair no Admin; o mesmo link não pode abrir de novo.
- [ ] Abrir o HTTPS externo, conferir certificado e formulário de login, entrar com as credenciais.
- [ ] Ver Admin no menu desde o primeiro acesso e a pergunta sobre o nome. Enviar nome pela conversa.
- [ ] Preencher função, tom e foto. Abrir Tutorial e cada `?`. Conferir 390 px sem corte horizontal.
- [ ] Criar uma vez; tocar duas vezes/recarregar não pode criar um segundo agente.
- [ ] Confirmar pelo Admin que o helper chamou a CLI real, criou casa, container e registro.
- [ ] Ver animação durante a criação, sem badge enquanto faltar a resposta real.
- [ ] Conectar assinatura no painel do novo agente. Voltar ao Admin em “Já entrei. Pode testar”.
- [ ] Conferir uma resposta nova do agente. A caixa treme, racha, abre e revela nome e foto.
- [ ] Tocar na badge e confirmar a URL `/a/<slug>` e a conversa do agente. Enviar um oi e receber resposta.
- [ ] Repetir sem foto e com Reduzir Movimento ligado: avatar neutro, transição curta e link funcionando.
- [ ] Reiniciar Web: pedido e foto continuam. Recarregar durante a geração mantém o andamento.
- [ ] Simular falta de login/queda de runner: mensagem explica, não celebra sucesso e Admin retoma o pedido.
- [ ] Capturar 390 e 1440 sem credenciais; publicar somente os prints no armazenamento de entrega.
- [ ] Validar URLs HTTPS e enviar ao responsável pelo teste o painel de teste, prints e resultado. Credenciais por canal privado.


## Entrada simplificada e instalação rápida

- Pedidos de instalação: testar “baixa, analisa e instala” com link e “instala” na pasta aberta,
  acompanhando as etapas de INSTALL.md. README permanece escrito para a pessoa.
- Sem `--com-imagem`, o painel e o Admin sobem sem construir a imagem; a unidade existe para
  o Admin iniciá-la depois. Conferir `--com-imagem` como caminho opcional.
- O botão “Quero criar meu primeiro agente” envia exatamente essa frase. A pergunta do nome
  vem depois. Preencher nome do dono e conferir a saudação real na conversa nova.
- Testar upload e Gerar avatar separadamente. Gerar avatar é desenho local, sem IA.
- Após tocar na badge, conferir a orientação para o menu esquerdo e o nome do agente.

- Runner indisponível com Web acessível: cabeçalho mostra “agente sem sinal”, nunca “pronto”.
  Restabelecer o runner e conferir a atualização automática do estado.
