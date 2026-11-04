# Rádio Tec: motor de playout (Liquidsoap 2.2)
# Pede a próxima faixa ao painel, faz crossfade, troca para o ao vivo
# quando o locutor conecta e nunca deixa a rádio em silêncio.

settings.log.stdout := true
settings.log.file := false
settings.init.allow_root := true

api       = environment.get(default="http://app:3000", "API_URL")
key       = environment.get(default="troque-esta-chave", "INTERNAL_KEY")
ice_host  = environment.get(default="icecast", "ICECAST_HOST")
ice_pass  = environment.get(default="hackme", "ICECAST_SOURCE_PASSWORD")
live_pass = environment.get(default="aovivo", "LIVE_PASSWORD")
name      = environment.get(default="Rádio Tec", "STATION_NAME")

headers = [("x-radio-key", key), ("Content-Type", "application/json")]

def post(path, body) =
  thread.run(fast=false, fun () -> ignore(http.post(headers=headers, timeout=5., data=body, "#{api}#{path}")))
end

# 1. Automação: o painel decide a próxima faixa (grade, relógio, rotação).
def next_track() =
  r = http.get(headers=headers, timeout=5., "#{api}/internal/next")
  if r.status_code == 200 then
    uri = string.trim(r)
    log.important("Próxima faixa: #{uri}")
    request.create(uri)
  else
    log.important("Painel sem faixa (HTTP #{r.status_code}), segurança assume")
    null()
  end
end

auto = request.dynamic(id="automacao", retry_delay=3., next_track)
# Volume por faixa: o painel mede o loudness (meta -16 LUFS) e manda liq_amplify em dB.
auto = amplify(1., auto)
auto = crossfade(duration=3., fade_in=1.5, fade_out=2.5, auto)

# Avisa o painel o que entrou no ar (tocando agora + log do ECAD).
auto = on_track(auto, fun (m) -> post("/internal/played", metadata.json.stringify(m)))

# 2. Ao vivo: o locutor conecta (BUTT, Mixxx, mAirList) em :8005, ponto /live.
live = input.harbor(
  "live",
  port=8005,
  password=live_pass,
  buffer=3.,
  on_connect=fun (_) -> post("/internal/live", '{"on":true}'),
  on_disconnect=fun () -> post("/internal/live", '{"on":false}')
)
live = on_track(live, fun (m) -> post("/internal/played", metadata.json.stringify(m)))

# 3. Segurança: playlist de reserva se o painel parar de responder.
seguranca = playlist(mode="randomize", reload_mode="watch", "/data/seguranca")

# Ordem de prioridade: ao vivo > automação > segurança > silêncio.
radio = fallback(id="radio", track_sensitive=false, [live, auto, seguranca])
radio = mksafe(radio)

# 4. Saídas para o Icecast: AAC (principal) e MP3 (compatibilidade).
output.icecast(
  %mp3(bitrate=128, samplerate=44100, stereo=true),
  host=ice_host, port=8000, password=ice_pass,
  mount="radio.mp3", name=name, genre="Variedades",
  description="#{name}, no ar 24 horas",
  radio
)

output.icecast(
  %ffmpeg(format="adts", %audio(codec="aac", b="128k", ar=44100, ac=2)),
  host=ice_host, port=8000, password=ice_pass,
  mount="radio.aac", format="audio/aac", name=name, genre="Variedades",
  description="#{name}, no ar 24 horas",
  radio
)
