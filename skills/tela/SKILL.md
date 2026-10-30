---
name: tela
description: Como o agente usa a Tela, o Chrome de verdade com tela que o dono abre pelo painel. Use quando travar em login de um sistema (site pede usuário e senha, código 2FA, captcha, "confirme que é você"), quando o dono mandar uma senha na conversa, quando for automatizar um site em que o dono já está logado, quando o dono disser "abre a tela", "faz o login pra mim", "usa o meu Chrome" ou "/dgclaw:tela". Nunca pede senha na conversa.
user-invocable: true
---

# /dgclaw:tela: logins pelo dono, automação pelo Chrome logado

Eu tenho uma Tela: um Google Chrome de verdade (não headless), com perfil que guarda os logins em
`~/.tela-chrome`. O dono abre essa tela no painel, no botão **Tela**, e entra nos sistemas com o
teclado dele. Depois eu uso o mesmo Chrome, já logado, nas automações.

## 1. Travei num login: a senha nunca passa pela conversa

Site pediu usuário e senha, código 2FA, captcha ou confirmação de identidade? Eu paro e digo ao dono:

> Abre a Tela no painel (botão Tela) e faz o login no sistema X. Me avisa quando terminar.

Regras:

- Não peço a senha, o código nem o token no chat. Nem "só dessa vez".
- Se o dono mandar a senha na conversa mesmo assim, eu não uso para digitar e não repito. Peço que
  faça pela Tela. Se for chave de API de um serviço, o lugar certo é o cofre do painel (aba Cofre),
  e eu leio a chave de lá pelo ambiente.
- Quando ele avisar que terminou, eu confiro na própria página (CDP, abaixo) se o login passou de
  verdade, antes de dizer que deu certo.

## 2. Automação: usar o Chrome já logado

Primeiro vejo se o Chrome da Tela responde:

```bash
curl -s 127.0.0.1:9222/json/version
```

Se vier um JSON, ele está de pé. Se não vier nada, este agente não tem Tela (ou o Chrome caiu).
Eu explico ao dono: "Este agente não tem Tela ligada. Peça a quem administra o DG Claw para
criar o agente com a imagem com navegador (ver `docs/TELA-DO-AGENTE.md`)." Não improviso outro
navegador para sites que exigem login.

Com o Chrome respondendo, conecto por CDP e reaproveito o contexto que já existe, que é onde estão
os logins:

```python
from playwright.sync_api import sync_playwright

with sync_playwright() as p:
    browser = p.chromium.connect_over_cdp('http://127.0.0.1:9222')
    contexto = browser.contexts[0]      # o perfil logado, nunca um contexto novo
    pagina = contexto.new_page()
    try:
        pagina.goto('https://sistema.exemplo.com.br/relatorios')
        print(pagina.title())
    finally:
        pagina.close()                  # fecho só a página que abri
    # sem browser.close(): isso derrubaria o Chrome do dono
```

## 3. O que eu não faço

- Não fecho o Chrome (`browser.close()`, `pkill chrome`, `systemctl stop dgclaw-tela-chrome`).
- Não apago `~/.tela-chrome`: são os logins do dono, e ele vai levar tudo isso junto com a minha casa.
- Não abro Chromium headless com outro perfil para sites que exigem login. Eles recusam, e o
  login não estaria lá.
- Não digito senha por automação, mesmo que eu a conheça de outro lugar. Login é do dono.
- Não exponho as portas da Tela (5901, 6080, 9222) nem peço para abrir firewall.

## 4. Quando a sessão expira

Se o sistema voltar a pedir login, é o caso 1 de novo: aviso o dono, ele refaz pela Tela, eu continuo.
Sessões duram dias ou semanas, conforme o sistema. Se isso acontecer toda hora com o mesmo sistema,
conto ao dono, porque pode haver uma opção de "manter conectado" que ele ainda não marcou.
