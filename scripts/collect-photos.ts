/**
 * 물건사진 수집 스크립트
 * https://www.courtauction.go.kr — 매각예정 물건 상세의 사진 API 탐색 및 다운로드
 *
 * 전략:
 *  1. PGJ157M00 페이지 → 법원 검색 → 물건 선택
 *  2. Network 인터셉트로 사진 관련 API 엔드포인트 탐색
 *  3. 발견된 API로 사진 바이너리 다운로드
 *  4. 결과를 JSON + 파일로 저장
 *
 * 실행:
 *  node --experimental-strip-types scripts/collect-photos.ts [옵션]
 * 옵션:
 *  --court   서울중앙지방법원   수집 법원 (기본: 서울중앙지방법원)
 *  --limit   1                대상 물건 수 (기본: 1)
 *  --output  /tmp/photos      사진 저장 디렉토리
 *  --dry-run                  API 탐색만, 실제 다운로드 안 함
 */

import { chromium, type Browser, type Page, type Response } from 'playwright';
import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';

// ── 타입 ──
interface PhotoEndpoint {
  url: string;
  method: string;
  postData: string | null;
  contentType: string;
  size: number;
  responsePreview: string;
}

interface PhotoResult {
  caseNumber: string;
  address: string;
  photos: {
    seq: number;
    url: string;
    fileId: string | null;
    fileName: string | null;
    size: number;
    savedPath: string | null;
  }[];
  discoveredEndpoints: PhotoEndpoint[];
  allNetworkRequests: string[];
}

// ── 유틸 ──
function delay(ms: number) {
  return new Promise<void>(r => setTimeout(r, ms));
}

function parseArgs(): Record<string, string> {
  const args = process.argv.slice(2);
  const result: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      const key = args[i].slice(2);
      result[key] = args[i + 1]?.startsWith('--') ? 'true' : (args[++i] ?? 'true');
    }
  }
  return result;
}

// ── 메인 스크래퍼 ──
class PhotoScraper {
  private page!: Page;
  private browser!: Browser;
  private networkLog: { url: string; method: string; contentType: string; size: number }[] = [];
  private photoEndpoints: PhotoEndpoint[] = [];

  async init(): Promise<void> {
    console.log('[브라우저] 초기화...');
    this.browser = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
        '--disable-gpu', '--disable-blink-features=AutomationControlled',
        '--window-size=1920,1080', '--lang=ko-KR',
      ],
    });
    const ctx = await this.browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      viewport: { width: 1920, height: 1080 },
      locale: 'ko-KR',
      timezoneId: 'Asia/Seoul',
    });
    await ctx.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      (window as Record<string, unknown>).chrome = { runtime: {} };
    });
    this.page = await ctx.newPage();

    // 전체 네트워크 모니터링
    this.page.on('response', async (res: Response) => {
      const url = res.url();
      const contentType = res.headers()['content-type'] || '';
      const size = Number(res.headers()['content-length'] || 0);

      // 이미지 또는 사진 관련 요청 캡처
      const isPhotoRelated = (
        contentType.includes('image/') ||
        url.includes('photo') || url.includes('Photo') ||
        url.includes('img') || url.includes('Img') ||
        url.includes('file') || url.includes('File') ||
        url.includes('download') || url.includes('Download') ||
        url.includes('.jpg') || url.includes('.jpeg') ||
        url.includes('.png') || url.includes('.gif')
      );

      if (isPhotoRelated) {
        console.log(`  [PHOTO-NET] ${res.status()} ${url.slice(0, 100)}`);
        console.log(`              Content-Type: ${contentType}, Size: ${size}`);

        try {
          const req = res.request();
          const postData = req.postData();

          // 이미지 응답이면 바이너리 수집
          if (contentType.includes('image/')) {
            const buffer = await res.body().catch(() => null);
            const endpoint: PhotoEndpoint = {
              url,
              method: req.method(),
              postData,
              contentType,
              size: buffer?.length || size,
              responsePreview: `[IMAGE BINARY ${buffer?.length || 0} bytes]`,
            };
            this.photoEndpoints.push(endpoint);
          } else {
            // JSON/HTML 응답
            const text = await res.text().catch(() => '');
            const endpoint: PhotoEndpoint = {
              url,
              method: req.method(),
              postData,
              contentType,
              size: text.length,
              responsePreview: text.slice(0, 300),
            };
            this.photoEndpoints.push(endpoint);
          }
        } catch {
          // 무시
        }
      }

      // 전체 .on API 요청 로그 (사진 관련 새 엔드포인트 탐색)
      if (url.includes('.on') || url.includes('.xml')) {
        this.networkLog.push({
          url,
          method: res.request().method(),
          contentType,
          size,
        });
      }
    });
  }

  /** 매각예정 페이지 → 법원 검색 → 물건 리스트 수집 */
  async getItemList(courtName: string): Promise<{ srnSaNo: string; printSt: string; docid: string }[]> {
    console.log(`\n[검색] ${courtName} 매각예정 물건 조회...`);

    await this.page.goto(
      'https://www.courtauction.go.kr/pgj/index.on?w2xPath=/pgj/ui/pgj100/PGJ157M00.xml',
      { waitUntil: 'networkidle', timeout: 40000 }
    );
    await delay(1500);

    await this.page.selectOption('#mf_wfm_mainFrame_sbx_dspslSchdGdsCortOfc', courtName);
    await delay(500);

    let listData: { srnSaNo: string; printSt: string; docid: string }[] = [];

    const handler = async (res: Response) => {
      if (res.url().includes('searchControllerMain.on')) {
        try {
          const json = await res.json();
          const items = json.data?.dlt_srchResult || [];
          listData = items.map((it: Record<string, unknown>) => ({
            srnSaNo: String(it.srnSaNo || ''),
            printSt: String(it.printSt || ''),
            docid: String(it.docid || ''),
          }));
          console.log(`    총 ${items.length}건 수신`);
        } catch { /* ignore */ }
      }
    };

    this.page.on('response', handler);
    await this.page.click('#mf_wfm_mainFrame_btn_dspslSchdGdsSrch');
    await delay(7000);
    this.page.off('response', handler);

    return listData;
  }

  /** 물건 상세 클릭 → 사진 API 탐색 */
  async collectPhotosForItem(
    item: { srnSaNo: string; printSt: string },
    outputDir: string,
    dryRun: boolean
  ): Promise<PhotoResult> {
    console.log(`\n[사진수집] ${item.srnSaNo}...`);

    // photoEndpoints 초기화 (이 물건 전용)
    const prevCount = this.photoEndpoints.length;

    // 소재지 링크 클릭
    const shortAddr = item.printSt.split('\n')[0].split('(')[0].trim().slice(0, 15);
    try {
      const addrLocator = this.page.locator('a').filter({ hasText: shortAddr }).first();
      await addrLocator.waitFor({ timeout: 5000 });
      await addrLocator.click();
      await delay(4000);
    } catch {
      console.log('  주소 링크 클릭 실패 — 사건번호로 재시도');
      try {
        await this.page.evaluate((srnSaNo) => {
          const els = Array.from(document.querySelectorAll('td, div, a'));
          for (const el of els) {
            if (el.textContent?.includes(srnSaNo)) {
              const a = el.tagName === 'A' ? el : el.querySelector('a');
              if (a) { (a as HTMLElement).click(); return; }
            }
          }
        }, item.srnSaNo);
        await delay(4000);
      } catch { /* ignore */ }
    }

    // ─ 사진 탭/버튼 클릭 (다양한 방식 시도) ─
    console.log('  [사진 탭/버튼 탐색]');

    // 1. 사진 버튼 (id 패턴 탐색)
    const photoButtonIds = [
      'btn_photo', 'btn_img', 'btn_picture', 'tab_photo',
      'mf_wfm_mainFrame_btn_photo', 'mf_wfm_mainFrame_tab_photo',
    ];
    for (const btnId of photoButtonIds) {
      try {
        const btn = this.page.locator(`#${btnId}`);
        if (await btn.isVisible().catch(() => false)) {
          console.log(`    버튼 발견: #${btnId}`);
          await btn.click();
          await delay(3000);
          break;
        }
      } catch { /* ignore */ }
    }

    // 2. "사진" 텍스트 포함 버튼/탭
    try {
      const photoTab = this.page.locator('button, a, li, td').filter({ hasText: /^사진$|^물건사진$|^현장사진$/ }).first();
      if (await photoTab.isVisible().catch(() => false)) {
        console.log('    "사진" 텍스트 버튼 발견');
        await photoTab.click();
        await delay(3000);
      }
    } catch { /* ignore */ }

    // 3. 사진 이미지 강제 로드 시도 — DOM에서 사진 관련 요소 탐색
    const domPhotoInfo = await this.page.evaluate(() => {
      // 이미지 태그 전체 수집
      const imgs = Array.from(document.querySelectorAll('img')).map(img => ({
        id: img.id,
        src: img.src,
        alt: img.alt,
        className: img.className,
        naturalWidth: img.naturalWidth,
        naturalHeight: img.naturalHeight,
        visible: img.offsetParent !== null,
      }));

      // 사진 관련 href 링크
      const photoLinks = Array.from(document.querySelectorAll('a')).filter(a =>
        a.textContent?.includes('사진') ||
        a.href?.includes('photo') ||
        a.href?.includes('img') ||
        a.onclick?.toString().includes('photo') ||
        a.onclick?.toString().includes('img')
      ).map(a => ({
        text: a.textContent?.trim() || '',
        href: a.href,
        onclick: a.getAttribute('onclick') || '',
        id: a.id,
      }));

      // onclick에서 사진 함수 탐색
      const allClickable = Array.from(document.querySelectorAll('[onclick]')).filter(el => {
        const onclick = el.getAttribute('onclick') || '';
        return onclick.toLowerCase().includes('photo') ||
               onclick.toLowerCase().includes('img') ||
               onclick.toLowerCase().includes('picture') ||
               onclick.toLowerCase().includes('사진');
      }).map(el => ({
        tag: el.tagName,
        id: el.id,
        text: el.textContent?.trim().slice(0, 30) || '',
        onclick: el.getAttribute('onclick') || '',
      }));

      // 사진 관련 전역 JS 함수명 탐색
      const globalFns = Object.keys(window).filter(k =>
        k.toLowerCase().includes('photo') ||
        k.toLowerCase().includes('picture') ||
        k.toLowerCase().includes('img')
      );

      return { imgs, photoLinks, allClickable, globalFns };
    });

    console.log(`  [DOM 분석]`);
    console.log(`    이미지 태그: ${domPhotoInfo.imgs.length}개`);
    console.log(`    사진 링크: ${domPhotoInfo.photoLinks.length}개`);
    console.log(`    사진 onclick: ${domPhotoInfo.allClickable.length}개`);

    // 실제 src가 있는 이미지 출력
    const visibleImgs = domPhotoInfo.imgs.filter(img =>
      img.src && !img.src.includes('data:') &&
      img.naturalWidth > 10 && img.naturalHeight > 10
    );
    console.log(`    실제 이미지 (${visibleImgs.length}개):`);
    visibleImgs.slice(0, 10).forEach(img => {
      console.log(`      [${img.id || 'no-id'}] ${img.src.slice(0, 80)} (${img.naturalWidth}x${img.naturalHeight})`);
    });

    if (domPhotoInfo.photoLinks.length > 0) {
      console.log(`    사진 링크 목록:`);
      domPhotoInfo.photoLinks.forEach(link => {
        console.log(`      "${link.text}" href="${link.href.slice(0, 60)}" onclick="${link.onclick.slice(0, 60)}"`);
      });
    }

    if (domPhotoInfo.allClickable.length > 0) {
      console.log(`    사진 onclick 요소:`);
      domPhotoInfo.allClickable.forEach(el => {
        console.log(`      [${el.tag}#${el.id}] "${el.text}" onclick="${el.onclick.slice(0, 80)}"`);
      });
    }

    // 4. 발견된 onclick 함수 실행 시도
    for (const el of domPhotoInfo.allClickable.slice(0, 3)) {
      if (el.id) {
        try {
          console.log(`    onclick 실행: #${el.id}`);
          await this.page.click(`#${el.id}`);
          await delay(2000);
        } catch { /* ignore */ }
      }
    }

    // ─ 추가 대기 (동적 로드) ─
    await delay(2000);

    // ─ 이 물건에서 수집된 사진 엔드포인트 ─
    const newEndpoints = this.photoEndpoints.slice(prevCount);
    console.log(`  [발견된 사진 엔드포인트: ${newEndpoints.length}개]`);
    newEndpoints.forEach(ep => {
      console.log(`    ${ep.method} ${ep.url.slice(0, 80)}`);
      console.log(`    ContentType: ${ep.contentType}, Size: ${ep.size}`);
      if (ep.postData) console.log(`    PostData: ${ep.postData.slice(0, 100)}`);
    });

    // ─ 사진 다운로드 ─
    const savedPhotos: PhotoResult['photos'] = [];

    const imageEndpoints = newEndpoints.filter(ep => ep.contentType.includes('image/'));
    console.log(`  [이미지 응답: ${imageEndpoints.length}개]`);

    if (!dryRun && imageEndpoints.length > 0) {
      if (!existsSync(outputDir)) {
        mkdirSync(outputDir, { recursive: true });
      }
      const safeCase = item.srnSaNo.replace(/[^a-zA-Z0-9가-힣]/g, '_');
      const caseDir = join(outputDir, safeCase);
      mkdirSync(caseDir, { recursive: true });

      for (let i = 0; i < imageEndpoints.length; i++) {
        const ep = imageEndpoints[i];
        try {
          // 세션 컨텍스트 내에서 이미지 다운로드
          const imgBuffer = await this.page.evaluate(async (url) => {
            const res = await fetch(url, { credentials: 'include' });
            if (!res.ok) return null;
            const buf = await res.arrayBuffer();
            return Array.from(new Uint8Array(buf));
          }, ep.url);

          if (imgBuffer && imgBuffer.length > 0) {
            const ext = ep.contentType.includes('png') ? 'png' :
                        ep.contentType.includes('gif') ? 'gif' : 'jpg';
            const fileName = `${i}.${ext}`;
            const filePath = join(caseDir, fileName);
            writeFileSync(filePath, Buffer.from(imgBuffer));
            console.log(`    ✅ 사진 저장: ${filePath} (${imgBuffer.length} bytes)`);

            // URL에서 fileId 추출 시도
            const fileIdMatch = ep.url.match(/[?&](?:fileId|file_id|imgId|id)=([^&]+)/i);
            const fileNameMatch = ep.url.match(/[?&](?:fileName|file_name|imgName|name)=([^&]+)/i) ||
                                  ep.url.match(/\/([^/]+\.(jpg|jpeg|png|gif))(?:\?|$)/i);

            savedPhotos.push({
              seq: i,
              url: ep.url,
              fileId: fileIdMatch ? fileIdMatch[1] : null,
              fileName: fileNameMatch ? fileNameMatch[1] : null,
              size: imgBuffer.length,
              savedPath: filePath,
            });
          }
        } catch (e) {
          console.log(`    ❌ 이미지 다운로드 실패: ${e}`);
          savedPhotos.push({
            seq: i,
            url: ep.url,
            fileId: null,
            fileName: null,
            size: 0,
            savedPath: null,
          });
        }
      }
    } else if (imageEndpoints.length > 0) {
      // dry-run: URL만 기록
      imageEndpoints.forEach((ep, i) => {
        savedPhotos.push({
          seq: i,
          url: ep.url,
          fileId: null,
          fileName: null,
          size: ep.size,
          savedPath: null,
        });
      });
    }

    // 사진 없는 경우 — DOM에서 실제 이미지 src 재시도
    if (savedPhotos.length === 0) {
      console.log('  [폴백] DOM img 태그에서 사진 URL 재수집...');
      const fallbackImgs = await this.page.evaluate(() => {
        return Array.from(document.querySelectorAll('img')).filter(img => {
          const src = img.src || '';
          return src.startsWith('http') &&
                 !src.includes('/icon') &&
                 !src.includes('/btn') &&
                 !src.includes('/logo') &&
                 !src.includes('spacer') &&
                 img.naturalWidth > 50 &&
                 img.naturalHeight > 50;
        }).map(img => ({
          src: img.src,
          alt: img.alt,
          width: img.naturalWidth,
          height: img.naturalHeight,
        }));
      });

      console.log(`    폴백 이미지: ${fallbackImgs.length}개`);
      fallbackImgs.forEach((img, i) => {
        console.log(`      [${i}] ${img.src.slice(0, 80)} (${img.width}x${img.height})`);
        savedPhotos.push({
          seq: i,
          url: img.src,
          fileId: null,
          fileName: img.alt || null,
          size: 0,
          savedPath: null,
        });
      });
    }

    return {
      caseNumber: item.srnSaNo,
      address: item.printSt.split('\n')[0].trim(),
      photos: savedPhotos,
      discoveredEndpoints: newEndpoints,
      allNetworkRequests: this.networkLog.slice(-20).map(r => r.url),
    };
  }

  async close(): Promise<void> {
    await this.browser?.close();
  }
}

// ── CLI 실행 ──
const args = parseArgs();
const courtName = args['court'] || '서울중앙지방법원';
const limit = parseInt(args['limit'] ?? '1');
const outputDir = args['output'] || '/tmp/auction-photos';
const dryRun = args['dry-run'] === 'true';

console.log('=== 물건사진 수집 시작 ===');
console.log(`법원: ${courtName}, 건수: ${limit}, 출력: ${outputDir}, dry-run: ${dryRun}`);

const scraper = new PhotoScraper();
try {
  await scraper.init();

  const list = await scraper.getItemList(courtName);
  if (list.length === 0) {
    console.log('수집된 물건 없음');
    process.exit(0);
  }

  const targets = limit > 0 ? list.slice(0, limit) : list;
  const results: PhotoResult[] = [];

  for (const item of targets) {
    const result = await scraper.collectPhotosForItem(item, outputDir, dryRun);
    results.push(result);
    console.log(`\n  → 사진 ${result.photos.length}장 수집 (엔드포인트 ${result.discoveredEndpoints.length}개 발견)`);
    await delay(1000);
  }

  // 결과 저장
  const output = {
    meta: { court: courtName, collectedAt: new Date().toISOString(), total: results.length, dryRun },
    results,
  };

  const jsonPath = join(outputDir, 'photo-result.json');
  if (!existsSync(outputDir)) mkdirSync(outputDir, { recursive: true });
  writeFileSync(jsonPath, JSON.stringify(output, null, 2));
  console.log(`\n[저장] ${jsonPath}`);

  // 요약
  console.log('\n=== 수집 요약 ===');
  results.forEach(r => {
    console.log(`${r.caseNumber}: 사진 ${r.photos.length}장, 엔드포인트 ${r.discoveredEndpoints.length}개`);
    r.discoveredEndpoints.forEach(ep => {
      console.log(`  ${ep.method} ${ep.url.slice(0, 100)}`);
    });
  });
} finally {
  await scraper.close();
}
