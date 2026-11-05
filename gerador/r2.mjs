// Acervo no Cloudflare R2: lista os áudios enviados pelo painel da Cloudflare,
// trata só os novos (volume e MP3 leve) e guarda o resultado em _tratado/ no próprio R2.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { S3Client, ListObjectsV2Command, GetObjectCommand, PutObjectCommand, DeleteObjectsCommand } from '@aws-sdk/client-s3';
import { parseFile } from 'music-metadata';

const AUDIO = /\.(mp3|m4a|aac|wav|flac|ogg|opus)$/i;
const PASTAS = { musicas: 'musica', vinhetas: 'vinheta', horacerta: 'horacerta', comerciais: 'comercial', podcasts: 'podcast', programas: 'programa' };
const INDICE = '_tratado/indice.json';

export function r2Configurado() {
  return !!(process.env.R2_ACCOUNT_ID && process.env.R2_ACCESS_KEY_ID && process.env.R2_SECRET_ACCESS_KEY);
}

function cliente() {
  return new S3Client({
    region: 'auto',
    endpoint: process.env.R2_ENDPOINT || `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    forcePathStyle: !!process.env.R2_ENDPOINT,
    credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY },
  });
}

async function listar(s3, bucket) {
  const out = [];
  let token;
  do {
    const r = await s3.send(new ListObjectsV2Command({ Bucket: bucket, ContinuationToken: token }));
    for (const o of r.Contents || []) out.push({ key: o.Key, etag: (o.ETag || '').replace(/"/g, ''), size: o.Size });
    token = r.IsTruncated ? r.NextContinuationToken : undefined;
  } while (token);
  return out;
}

async function baixar(s3, bucket, key, destino) {
  const r = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  await pipeline(r.Body, fs.createWriteStream(destino));
}

/**
 * Retorna as faixas do R2 no mesmo formato do acervo local, com `url` pública do áudio tratado.
 * tratar(origem, destino) é a função de ffmpeg do gerador.
 */
export async function lerAcervoR2({ tratar, regras, log }) {
  const bucket = process.env.R2_BUCKET || 'radiotec';
  const publico = (process.env.R2_PUBLIC_URL || '').replace(/\/$/, '');
  if (!publico) throw new Error('Falta R2_PUBLIC_URL (endereço público do bucket, ex.: https://pub-xxxx.r2.dev)');
  const s3 = cliente();
  const objetos = await listar(s3, bucket);

  let indice = {};
  if (objetos.some((o) => o.key === INDICE)) {
    const tmp = path.join(os.tmpdir(), 'indice.json');
    await baixar(s3, bucket, INDICE, tmp);
    try { indice = JSON.parse(fs.readFileSync(tmp, 'utf8')); } catch { indice = {}; }
  }

  const chaveTrat = `${regras.volumeLUFS}_${regras.bitrate}`;
  const originais = objetos.filter((o) => !o.key.startsWith('_') && AUDIO.test(o.key) && PASTAS[o.key.split('/')[0]]);
  const trabalho = path.join(os.tmpdir(), 'radiotec-r2');
  fs.mkdirSync(trabalho, { recursive: true });

  const faixas = [];
  let novos = 0;
  const fila = [...originais];
  const worker = async () => {
    while (fila.length) {
      const o = fila.shift();
      const partes = o.key.split('/');
      const cat = PASTAS[partes[0]];
      const id = crypto.createHash('sha1').update(`${o.key}|${o.etag}|${chaveTrat}`).digest('hex').slice(0, 16);
      let info = indice[id];
      if (!info) {
        const orig = path.join(trabalho, `${id}-original${path.extname(o.key)}`);
        const trat = path.join(trabalho, `${id}.mp3`);
        try {
          await baixar(s3, bucket, o.key, orig);
          let meta = {};
          try { meta = await parseFile(orig, { duration: true }); } catch { /* sem tags */ }
          await tratar(orig, trat);
          const dur = (await parseFile(trat, { duration: true })).format.duration || meta.format?.duration || 0;
          await s3.send(new PutObjectCommand({ Bucket: bucket, Key: `_tratado/${id}.mp3`, Body: fs.readFileSync(trat), ContentType: 'audio/mpeg', CacheControl: 'public, max-age=31536000, immutable' }));
          const c = meta.common || {};
          const nomeArq = path.basename(o.key, path.extname(o.key));
          info = {
            titulo: c.title || nomeArq.replace(/[-_]+/g, ' '), artista: c.artist || '', genero: (c.genre || [])[0] || '',
            compositor: (c.composer || [])[0] || '', isrc: (c.isrc || [])[0] || '', dur, nomeArq,
          };
          indice[id] = info;
          novos++;
          log(`tratado: ${o.key}`);
        } catch (e) {
          log(`aviso: não consegui tratar ${o.key} (${String(e.message || e).split('\n')[0]}), ignorado`);
          continue;
        } finally {
          fs.rmSync(orig, { force: true }); fs.rmSync(trat, { force: true });
        }
      }
      if (!info.dur) continue;
      faixas.push({
        origem: o.key, hash: id, cat,
        programa: cat === 'programa' && partes.length > 2 ? partes[1] : null,
        titulo: info.titulo, artista: info.artista, genero: info.genero, compositor: info.compositor, isrc: info.isrc,
        dur: info.dur, nomeArq: info.nomeArq,
        arquivo: `${publico}/_tratado/${id}.mp3`,
      });
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, Math.max(1, os.cpus().length)) }, worker));

  // Remove do índice e do bucket o que foi apagado pelo usuário.
  const vivos = new Set(faixas.map((f) => f.hash));
  const orfaos = Object.keys(indice).filter((id) => !vivos.has(id));
  for (const id of orfaos) delete indice[id];
  const apagar = objetos.filter((o) => o.key.startsWith('_tratado/') && o.key !== INDICE && !vivos.has(path.basename(o.key, '.mp3')));
  for (let i = 0; i < apagar.length; i += 1000) {
    await s3.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: apagar.slice(i, i + 1000).map((o) => ({ Key: o.key })) } }));
  }
  if (novos || orfaos.length || !objetos.some((o) => o.key === INDICE)) {
    await s3.send(new PutObjectCommand({ Bucket: bucket, Key: INDICE, Body: JSON.stringify(indice), ContentType: 'application/json' }));
  }
  log(`R2: ${faixas.length} áudio(s) no acervo, ${novos} novo(s) tratado(s), ${apagar.length} removido(s)`);
  // Ordem estável (programas tocam em ordem alfabética)
  return faixas.sort((a, b) => a.origem.localeCompare(b.origem, 'pt-BR', { numeric: true }));
}
