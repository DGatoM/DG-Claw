---
name: trocar-dominio
description: Troca o endereço do painel do DG Claw por um domínio ou subdomínio do próprio dono, explicando cada passo para quem é leigo e configurando o servidor. Use quando o dono disser "quero usar meu próprio domínio", "quero um endereço meu", "trocar o endereço do painel", "colocar painel.minhaempresa.com.br", "tirar esse hstgr.cloud ou sslip.io", "como eu ponho meu domínio?", ou perguntar por que o endereço do painel é esquisito.
user-invocable: true
---

# trocar-dominio: o painel no endereço do dono

O DG Claw nasce com um endereço automático (algo como `srv123456.hstgr.cloud` ou
`203-0-113-7.sslip.io`). Funciona e tem HTTPS, mas é feio. Esta skill leva o dono a um endereço
dele, como `painel.minhaempresa.com.br`. Quem pede quase nunca é técnico: fale simples, um passo por
vez, e só mexa no servidor depois que o DNS estiver certo.

> Se `dgclaw dominio` disser "atras de proxy existente", o HTTPS é do nginx ou do túnel do dono, não
> do Caddy do DG Claw. Nesse caso `dgclaw dominio trocar <nome>` só grava o nome e imprime os trechos
> novos para ele atualizar o proxy dele (o DNS e o certificado são dele); os passos abaixo sobre o IP
> da VPS e o Caddy não se aplicam.

## Passo 1: descubra o IP e entenda o que o dono tem

Rode `dgclaw dominio`. Ele mostra o endereço atual e o IP público da VPS (anote o IP).

Pergunte, uma coisa por vez:

1. Você já tem um domínio comprado? Onde (Hostinger, Registro.br, GoDaddy, Cloudflare)?
2. Esse domínio já tem um site no ar? Se tiver, recomende um subdomínio, como
   `painel.minhaempresa.com.br`, para não mexer no site que já existe.

Se ele ainda não tem domínio, explique que precisa comprar um (a Hostinger e o Registro.br vendem) e
volte aqui depois.

## Passo 2: o que o dono faz no painel de DNS

Explique assim: "O DNS é a agenda de telefones da internet. Vou te passar o que anotar nela para o
seu nome apontar para a sua VPS." Ele entra no painel de DNS de onde comprou o domínio e cria **um
registro**:

- Tipo: **A**
- Nome: `painel` (para `painel.minhaempresa.com.br`) ou `@` (para o domínio raiz, `minhaempresa.com.br`)
- Valor: o IP da VPS que você descobriu no passo 1
- TTL: o padrão

Cuidados:

- **Cloudflare:** a nuvem do registro tem que ficar **cinza** (só DNS), pelo menos até o certificado
  sair. Laranja atrapalha a emissão do HTTPS.
- Se já existir um registro **A** ou **AAAA** com esse mesmo nome apontando para outro lugar, ele
  troca o A pelo novo e apaga o AAAA (o AAAA antigo faz parte dos acessos cair no lugar errado).
- Usar domínio raiz (`@`) tira do ar o site que estiver nele. Por isso o subdomínio é a recomendação.

Peça que avise quando salvar.

## Passo 3: confira a propagação, sem mudar nada na VPS

Quando o dono avisar, rode:

```
dig +short A painel.minhaempresa.com.br @1.1.1.1
dig +short A painel.minhaempresa.com.br @8.8.8.8
```

Os dois precisam devolver exatamente o IP da VPS. Se algum vier vazio ou com outro número, o DNS ainda
não propagou: diga que pode levar de alguns minutos até algumas horas, peça para ele esperar e
confira de novo depois. Enquanto isso, **não mude nada na VPS**.

## Passo 4: troque

Com os dois devolvendo o IP certo:

```
dgclaw dominio trocar painel.minhaempresa.com.br
```

O comando confere o DNS de novo, reescreve o Caddy, recarrega, grava o domínio novo e espera o HTTPS
(o certificado sai sozinho, em geral em menos de um minuto). No fim imprime o link novo do painel.

Depois mande ao dono o link novo e avise:

- o endereço antigo deixa de abrir o painel;
- a senha e os agentes continuam exatamente iguais;
- se ele estiver logado, precisa entrar de novo no endereço novo (o login vale por endereço);
- guarde o endereço novo nos favoritos e, se tinha o app instalado no celular, instale de novo por ele.

Se ele pedir um link de primeiro acesso novo, é `dgclaw primeiro-acesso`.

Importante: este comando mexe só no Caddy e no domínio. Não reinicia o Admin, então a conversa não
cai. O Admin continua respondendo, mas o dono vai precisar abrir o endereço novo para continuar
falando com você.

## Problemas comuns

| O que aparece | O que dizer e fazer |
|---|---|
| "o DNS publico ainda nao aponta" | Ainda não propagou ou o registro está errado. Confira o tipo (A), o nome e o IP, espere e rode o `dig` de novo. |
| Cloudflare com nuvem laranja | Peça para deixar cinza (só DNS). Quando o certificado sair, ele pode voltar para laranja se quiser. |
| Existe um AAAA antigo | Peça para apagar o AAAA desse nome. Ele manda parte dos visitantes para o lugar errado. |
| "https nao respondeu em 90s" | O certificado ainda não saiu. Confira se as portas 80 e 443 estão abertas no firewall do painel da Hostinger e se o DNS ainda aponta para a VPS. Veja `journalctl -u caddy -n 30`. O Caddy tenta de novo sozinho. |
| "o Caddy recusou a configuracao" | O comando já voltou o arquivo ao que era. Confira o nome digitado e veja o erro em `caddy validate`. |
| O dono errou o nome | Rode `dgclaw dominio trocar <nome certo>` de novo, é seguro repetir. Para voltar ao automático, use o endereço antigo (`dgclaw dominio` o mostrou no começo). |

Só use `--sem-conferir-dns` se o dono souber o que está fazendo (por exemplo, o DNS está atrás de um
serviço que esconde o IP). Sem o DNS certo o HTTPS não sai.
