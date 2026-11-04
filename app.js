// 업로드 대상(전자서명 서비스) 제한은 2MB. OS마다 MB를 10^6 또는 2^20으로 세므로
// 어느 쪽으로 해석해도 안전하게 1,800,000바이트로 고정
const TARGET_BYTES = 1_800_000;
const MB = 1_000_000; // 표시는 iPhone/macOS와 같은 10진 단위
// iOS Safari 캔버스 최대 면적(16,777,216px) 이하로 유지 — 초과 시 toBlob이 null 반환
const MAX_PIXELS = 16_000_000;
const $ = (id) => document.getElementById(id);
let current = null; // { blob, name, url }
let busy = false;

const fmt = (b) => b >= MB ? (b / MB).toFixed(2) + ' MB' : Math.round(b / 1000) + ' KB';
const isTouch = matchMedia('(pointer: coarse)').matches;
// iPadOS는 데스크톱 UA(Macintosh)를 쓰므로 터치 포인트로 구분
const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent) ||
  (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);

function isHeic(file) {
  return /image\/hei[cf]/i.test(file.type) || /\.hei[cf]$/i.test(file.name);
}

let heicLib;
async function loadHeic2any() {
  if (!heicLib) {
    heicLib = new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = 'https://cdn.jsdelivr.net/npm/heic2any@0.0.4/dist/heic2any.min.js';
      s.onload = () => res(window.heic2any);
      s.onerror = () => { heicLib = null; rej(new Error('사진을 변환하지 못했습니다. 인터넷 연결을 확인한 뒤 다시 시도해 주십시오.')); };
      document.head.appendChild(s);
    });
  }
  return heicLib;
}

// 디코딩: EXIF 회전 자동 적용. HEIC는 Safari면 네이티브, 그 외엔 heic2any(WASM, 브라우저 내 변환)
async function decode(file) {
  try {
    return await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch (e) {
    if (!isHeic(file)) throw new Error('이 사진은 열 수 없습니다. 휴대폰 카메라로 찍은 사진을 골라 주십시오.');
    const heic2any = await loadHeic2any();
    const out = await heic2any({ blob: file, toType: 'image/jpeg', quality: 0.95 });
    const blob = Array.isArray(out) ? out[0] : out;
    return await createImageBitmap(blob, { imageOrientation: 'from-image' });
  }
}

function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

// 캔버스 메모리 즉시 반환 (iOS는 누적되면 탭이 죽음)
function release(canvas) { canvas.width = canvas.height = 0; }

function hasAlpha(bitmap) {
  // 축소본에서 투명 픽셀 존재 여부만 빠르게 확인
  const w = Math.min(bitmap.width, 256), h = Math.min(bitmap.height, 256);
  const c = makeCanvas(w, h);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0, w, h);
  const d = ctx.getImageData(0, 0, w, h).data;
  release(c);
  for (let i = 3; i < d.length; i += 4) if (d[i] < 255) return true;
  return false;
}

function render(bitmap, scale, fillWhite) {
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const c = makeCanvas(w, h);
  const ctx = c.getContext('2d');
  if (fillWhite) { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h); }
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, 0, 0, w, h);
  return c;
}

const toBlob = (canvas, type, q) => new Promise((res, rej) =>
  canvas.toBlob((b) => b ? res(b) : rej(new Error('사진이 너무 커서 처리하지 못했습니다. 다른 사진으로 다시 시도해 주십시오.')), type, q));

// 출력 형식: 전자서명 서비스가 받는 JPG/PNG만 사용.
// 투명 배경 인감은 PNG로 투명 유지, 그 외는 JPEG
function chooseOutputType(file, alpha) {
  return alpha ? 'image/png' : 'image/jpeg';
}

// 핵심 알고리즘: 품질 이진 탐색 → 부족하면 해상도 축소 후 반복
async function compress(bitmap, type, target) {
  const fillWhite = type === 'image/jpeg';
  let scale = Math.min(1, Math.sqrt(MAX_PIXELS / (bitmap.width * bitmap.height)));

  for (let attempt = 0; attempt < 12; attempt++) {
    const canvas = render(bitmap, scale, fillWhite);
    const size = { w: canvas.width, h: canvas.height };
    try {
      let lo = 0.5, hi = 0.92, best = null;
      const top = await toBlob(canvas, type, hi);
      if (top.size <= target) return { blob: top, ...size };

      // PNG는 품질 설정이 없으므로 해상도 축소만으로 맞춤
      const low = type === 'image/png' ? top : await toBlob(canvas, type, lo);
      if (low.size <= target) {
        best = low;
        for (let i = 0; i < 5; i++) {
          const q = (lo + hi) / 2;
          const b = await toBlob(canvas, type, q);
          if (b.size <= target) { best = b; lo = q; } else { hi = q; }
        }
        return { blob: best, ...size };
      }
      // 최저 품질로도 초과 → 크기 비율에 맞춰 해상도 축소 (파일 크기 ∝ 픽셀 수)
      scale *= Math.max(0.5, Math.min(0.9, Math.sqrt(target / low.size) * 0.95));
    } finally {
      release(canvas);
    }
  }
  throw new Error('용량을 충분히 줄이지 못했습니다. 다른 사진으로 다시 시도해 주십시오.');
}

function outName(name, type) {
  const base = name.replace(/\.[^.]+$/, '');
  const ext = type === 'image/png' ? 'png' : 'jpg';
  return `${base}_resized.${ext}`;
}

function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

// 저장 전략. 사용자가 공유 시트를 닫으면(AbortError) 조용히 무시.
async function saveFile(item) {
  const files = [new File([item.blob], item.name, { type: item.blob.type })];
  // iOS: 다운로드는 '파일' 앱으로 가므로 공유 시트("이미지 저장")로 사진 앱에 저장.
  // Android·데스크톱: 일반 다운로드 (Android는 Download 폴더 → 갤러리에 바로 보임)
  if (isIOS) {
    // share()는 탭 직후(사용자 제스처 안)에 호출돼야 하므로 앞에 await를 두지 않음
    if (navigator.canShare?.({ files })) {
      try { await navigator.share({ files }); }
      catch (e) { if (e.name !== 'AbortError') showHint(); }
    } else {
      showHint(); // 카카오톡 등 앱 내 브라우저: 다운로드하면 '파일'로 가버리므로 안내만
    }
    return;
  }
  download(item.blob, item.name);
}

// ---------- 화면 ----------
const views = ['viewStart', 'viewBusy', 'viewDone', 'viewError'];
function show(id) {
  views.forEach((v) => { $(v).hidden = v !== id; });
}

function showError(title, body) {
  $('errTitle').textContent = title;
  $('errBody').textContent = body;
  show('viewError');
}

function showHint() {
  $('hint').hidden = false;
  $('hint').scrollIntoView({ behavior: 'smooth', block: 'center' });
}

// 저장 위치는 OS마다 달라서 버튼 이름과 안내 문구도 다르게
$('saveLabel').textContent = isIOS ? '사진에 저장하기' : '저장하기';
$('saveTip').innerHTML = isIOS
  ? "누르면 창이 열립니다. 거기서 <b>'이미지 저장'</b>을 눌러 주십시오."
  : isTouch
    ? "저장한 사진은 <b>갤러리 앱의 다운로드(Download) 폴더</b>에서 찾을 수 있습니다."
    : '<b>다운로드 폴더</b>에 저장됩니다.';

async function processFiles(files) {
  if (busy || !files.length) return;
  const file = files.find((f) => f.type.startsWith('image/') || isHeic(f));
  if (!file) {
    showError('사진 파일이 아닙니다', '도장을 찍은 사진을 골라 주십시오.');
    return;
  }

  busy = true;
  show('viewBusy');
  if (current) { URL.revokeObjectURL(current.url); current = null; }
  try {
    const bitmap = await decode(file);
    const alpha = /png|webp|gif/i.test(file.type) && hasAlpha(bitmap);
    const type = chooseOutputType(file, alpha);
    const { blob } = await compress(bitmap, type, TARGET_BYTES);
    bitmap.close?.();

    current = { blob, name: outName(file.name, type), url: URL.createObjectURL(blob) };
    $('preview').src = current.url;
    $('sizes').innerHTML = `${fmt(file.size)} → <b>${fmt(blob.size)}</b> 로 줄었습니다.<br>이제 전자계약에 올릴 수 있습니다.`;
    $('hint').hidden = true;
    show('viewDone');
  } catch (e) {
    showError('사진을 줄이지 못했습니다', e.message || '다른 사진으로 다시 시도해 주십시오.');
  } finally {
    busy = false;
    window.scrollTo({ top: 0 });
  }
}

$('file').addEventListener('change', (e) => { processFiles([...e.target.files]); e.target.value = ''; });
$('save').addEventListener('click', () => current && saveFile(current));

// 데스크톱: 화면 어디든 끌어다 놓기
const drop = $('drop');
['dragenter', 'dragover'].forEach((t) => document.addEventListener(t, (e) => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach((t) => document.addEventListener(t, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
document.addEventListener('drop', (e) => processFiles([...e.dataTransfer.files]));
