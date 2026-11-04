# Rádio Tec · Sistema de programação 24h

Sistema próprio de playout para rádio web: biblioteca de mídia, relógios por hora, grade semanal com programas gravados e janelas ao vivo, rotação inteligente, tocando agora, relatório para o ECAD e página pública com player.

## Como funciona

```
Painel (app)  ──  decide a próxima faixa  ──>  Liquidsoap (playout)  ──>  Icecast (streaming)  ──>  ouvintes
     ^                                              ^
     └── tocando agora, log de execução             └── locutor ao vivo (BUTT/Mixxx) na porta 8005
```

| Peça | O que faz |
| --- | --- |
| `app/` | Painel web (Node + SQLite): biblioteca, relógios, grade, simulação, relatórios, API pública |
| `liquidsoap/radio.liq` | Motor que toca 24h: crossfade, volume por faixa, troca automática para o ao vivo, playlist de segurança |
| `icecast/` | Servidor que distribui o áudio (`/radio.aac` e `/radio.mp3`) |
| `caddy/` | HTTPS automático para painel, player e stream |
| `data/` | Banco, arquivos de áudio (`media/`) e playlist de segurança (`seguranca/`) |

## Regras de programação

- **Grade:** cada faixa da grade tem dia, início, fim e tipo.
  - *Relógio:* automação com o relógio escolhido.
  - *Programa gravado:* toca os arquivos do programa na ordem; se sobrar tempo, completa com o relógio.
  - *Janela ao vivo:* reservada para o locutor. Quando ele conecta, entra no ar na hora; se não conectar, a automação cobre.
- **Horários sem faixa** tocam o relógio padrão.
- **Relógio = uma hora.** Recomeça no início de cada hora. Hora certa só toca nos primeiros 5 minutos (arquivo com o título `Hora certa 14h`; um arquivo sem número vale para qualquer hora).
- **Rotação:** a mesma música não repete antes de 180 min e o mesmo artista antes de 60 min (ajustável). Se a biblioteca for pequena, as regras afrouxam para nunca ficar sem som.
- **Volume:** cada arquivo é medido no upload e ajustado para -16 LUFS.
- **Segurança:** se o painel cair, toca a pasta `data/seguranca/`. Coloque ali pelo menos 2 horas de músicas.

## Instalar num VPS (Ubuntu 22.04/24.04)

Requisitos: VPS com 2 vCPU, 4 GB RAM, 80 GB de disco, um domínio apontando para o IP do servidor (registro A, ex. `radio.seudominio.com.br`).

```bash
# 1. Docker
curl -fsSL https://get.docker.com | sh

# 2. Código
git clone <repositório> radio-tec && cd radio-tec
cp .env.example .env
nano .env            # domínio e TODAS as senhas

# 3. Subir
docker compose up -d --build
docker compose logs -f liquidsoap   # acompanhar o motor
```

Libere no firewall as portas **80**, **443** e **8005** (ao vivo).

Endereços:

| O quê | Endereço |
| --- | --- |
| Painel | `https://SEU_DOMINIO/admin` (usuário e senha do `.env`) |
| Página da rádio | `https://SEU_DOMINIO/` |
| Stream AAC | `https://SEU_DOMINIO/radio.aac` |
| Stream MP3 | `https://SEU_DOMINIO/radio.mp3` |
| Tocando agora (JSON) | `https://SEU_DOMINIO/api/nowplaying` |

## Primeiros passos no painel

1. **Biblioteca:** envie músicas, vinhetas, hora certa, comerciais e programas, cada um na categoria certa.
2. **Relógios:** ajuste o relógio *Padrão* ou crie outros (ex.: "Manhã", "Madrugada").
3. **Grade:** clique num horário para criar programas e janelas ao vivo. Use *Copiar um dia* para replicar.
4. **Simular:** confira as próximas horas antes de ir ao ar.
5. Copie algumas horas de música para `data/seguranca/` no servidor.

## Entrar ao vivo

No BUTT (grátis) ou Mixxx, configure:

- Tipo: **Icecast**
- Endereço: `SEU_DOMINIO`, porta **8005**
- Ponto de montagem: `live`
- Usuário: `source`, senha: `LIVE_PASSWORD` do `.env`
- Formato: MP3 192 kbps ou AAC

Ao conectar, a rádio troca para o ao vivo na hora. Ao desconectar, volta para a automação.

## Página da rádio no GitHub Pages

O arquivo `app/public/site/index.html` funciona sozinho. Para publicar no GitHub Pages, copie o arquivo para o repositório do site e troque a linha `const BASE = ...` pelo endereço do servidor, por exemplo `const BASE = 'https://radio.seudominio.com.br';`.

## ECAD

Em **Relatórios**, baixe a planilha de execução do período (data, hora, título, intérprete, compositor, ISRC, duração). Preencha compositor e ISRC das músicas para o relatório sair completo. A licença do ECAD precisa estar ativa antes de tocar música comercial.

## Rodar no computador para testar o painel

```bash
cd app && npm install
DATA_DIR=../data node src/server.js
# abre http://localhost:3000/admin  (admin / radiotec)
```

Sem o Liquidsoap rodando o áudio não sai, mas o painel, a grade e a simulação funcionam.

## Próximas fases

Usuários e papéis, estúdio no navegador, voice tracking, comerciais com relatório de veiculação, importação de podcasts por RSS, gravação do ar, estatísticas de audiência, pedidos de música e IA de programação.
