# Sprites do agente

## Formato esperado
- **Tipo:** GIF animado (corpo inteiro, pixel art)
- **Fundo:** Transparente
- **Tamanho recomendado:** ~300x550px
- **Estilo:** Pixel art consistente com avatar.jpg

## Arquivos por emocao
| Arquivo | Emocao / Mood | Quando usar |
|---------|---------------|-------------|
| default.gif | Padrao (correndo) | Fallback para qualquer mood sem GIF especifico |
| happy.gif | Feliz / Otimista | Joy > 0.6 ou mood "feliz"/"otimista" |
| sad.gif | Triste | Sadness > 0.3 ou mood "triste"/"melancolica" |
| excited.gif | Animada | Anticipation > 0.5 ou mood "animada"/"empolgada" |
| thinking.gif | Pensativa | mood "reflexiva"/"pensativa" |
| tranquila.gif | Tranquila | mood "tranquila" (baseline) |
| angry.gif | Irritada | Anger > 0.3 ou mood "irritada"/"frustrada" |
| tired.gif | Cansada | Energy < 0.3 ou mood "cansada"/"entediada" |

## Como trocar
Basta substituir o GIF correspondente nesta pasta. O dashboard detecta automaticamente pelo nome do arquivo.

## Avatar
- **avatar.jpg** - Rosto/bust pixel art, usado no header e na tela de login
