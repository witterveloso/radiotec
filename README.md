# Rádio Tec

Rádio web 24 horas que roda só com GitHub: sem servidor e sem mensalidade.

- **Rádio:** `https://witterveloso.github.io/radiotec/`
- **Painel de programação:** `https://witterveloso.github.io/radiotec/painel/`

## Como funciona

1. Os áudios ficam na pasta `acervo/` e a grade fica no arquivo `programacao.json`.
2. A cada alteração, o GitHub Actions:
   - trata os áudios: volume padrão de -16 LUFS e MP3 de 128 kbps;
   - monta a programação minuto a minuto de 28 dias;
   - publica tudo no GitHub Pages.
3. O player de cada ouvinte calcula pelo relógio o que está no ar. Todo mundo ouve a mesma música no mesmo ponto, como numa rádio.

Os programas entram no horário exato: se uma música for passar do horário, ela é encurtada com fade. A hora certa toca no início de cada hora. A programação se repete a cada 28 dias.

## Pastas do acervo

| Pasta | O que vai | Dica |
| --- | --- | --- |
| `acervo/musicas` | Músicas | Preencha título, artista, compositor e ISRC nas tags do MP3 (vão para o relatório do ECAD) |
| `acervo/vinhetas` | Vinhetas da rádio | |
| `acervo/horacerta` | Hora certa | Nomeie com a hora: `00h.mp3` … `23h.mp3` |
| `acervo/comerciais` | Comerciais e patrocínios | |
| `acervo/podcasts` | Episódios de podcast | Use no relógio como categoria "Podcast" |
| `acervo/programas/<nome>` | Programas gravados | Uma pasta por programa; os arquivos tocam em ordem alfabética (`01-bloco.mp3`, `02-bloco.mp3`) |

## Rotina

- **Enviar áudio:** no painel, aba Acervo, clique no botão da categoria. Arraste os arquivos e clique em *Commit changes*.
- **Mudar a grade ou os relógios:** edite no painel, vá em Publicar e clique em *Copiar e abrir no GitHub*. Cole o texto no arquivo e clique em *Commit changes*.
- Em 3 a 5 minutos a rádio está atualizada. O andamento aparece na aba **Actions** do repositório.

## Configuração inicial (uma vez só)

1. Em **Settings → Pages**, em *Build and deployment → Source*, escolha **GitHub Actions**.
2. Envie os áudios para as pastas do acervo.

## Limites desta versão

| Item | Limite do GitHub |
| --- | --- |
| Tamanho do site | Até 1 GB de áudio tratado (cerca de 17 horas de material em 128 kbps) |
| Arquivo | Até 100 MB cada (programas longos: dividir em blocos) |
| Tráfego | Em torno de 100 GB por mês, cerca de 1.700 horas de audição |
| Ao vivo | Não tem entrada de áudio ao vivo. A janela ao vivo mostra um botão com o link da live (YouTube ou Instagram) enquanto a programação segue tocando |
| Ouvintes | Sem contagem de audiência em tempo real |
| ECAD | O relatório é gerado a partir da programação publicada |

Quando a rádio crescer, a pasta `servidor/` tem o sistema completo para um VPS: streaming Icecast de verdade, entrada ao vivo, contagem de ouvintes e log real de execução. Veja `servidor/README.md`.

## Testar no computador

```bash
cd gerador && npm install && cd ..
node gerador/gerar.mjs        # gera o site em _site/
npx http-server _site -p 8080 # abre http://localhost:8080
```
