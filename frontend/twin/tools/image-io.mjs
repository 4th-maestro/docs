// 명령줄용 이미지 입출력 (설치할 것 없음)
//   decode: Windows 기본 이미지 해독기(System.Drawing)를 PowerShell로 불러 RGBA로
//   encodePng: RGBA → PNG (node 내장 zlib)
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

export function decode(file){
  const tmp = path.join(os.tmpdir(), `twin-${crypto.createHash('md5').update(file).digest('hex')}.bgra`);
  const ps = `Add-Type -AssemblyName System.Drawing; $b=[System.Drawing.Bitmap]::FromFile('${file.replace(/'/g, "''")}');
    $r=New-Object System.Drawing.Rectangle 0,0,$b.Width,$b.Height; $d=$b.LockBits($r,[System.Drawing.Imaging.ImageLockMode]::ReadOnly,[System.Drawing.Imaging.PixelFormat]::Format32bppArgb);
    $n=$d.Stride*$b.Height; $a=New-Object byte[] $n; [System.Runtime.InteropServices.Marshal]::Copy($d.Scan0,$a,0,$n); $b.UnlockBits($d);
    [System.IO.File]::WriteAllBytes('${tmp}',$a); Write-Output "$($b.Width) $($b.Height) $($d.Stride)"`;
  const [w, h, stride] = execFileSync('powershell.exe', ['-NoProfile', '-Command', ps], { encoding:'utf8' }).trim().split(/\s+/).map(Number);
  const src = fs.readFileSync(tmp), data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const s = y * stride + x * 4, o = (y * w + x) * 4; data[o] = src[s + 2]; data[o + 1] = src[s + 1]; data[o + 2] = src[s]; data[o + 3] = 255; }
  fs.unlinkSync(tmp);
  return { width:w, height:h, data };
}

const CRC = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
const crc32 = buf => { let c = -1; for (const b of buf) c = CRC[(c ^ b) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; };
const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]), crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td)); return Buffer.concat([len, td, crc]); };
export function encodePng({ width:w, height:h, data }){
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 4 + 1)] = 0; Buffer.from(data.buffer, data.byteOffset + y * w * 4, w * 4).copy(raw, y * (w * 4 + 1) + 1); }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
