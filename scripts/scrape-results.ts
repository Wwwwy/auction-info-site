/**
 * 매각결과 수집 스크래퍼
 * https://www.courtauction.go.kr/pgj/index.on?w2xPath=/pgj/ui/pgj100/PGJ158M00.xml
 *
 * 전략:
 *  1. 법원별 검색 → selectDspslSchdRsltSrch.on API 인터셉트 → 전체 페이지 순환 → 리스트 수집
 *  2. 각 페이지에서 moveCsDtlPage(N) 클릭 → 상세 페이지 이동
 *  3. 상단 두 번째 탭 (기일내역) 클릭 → 기일내역 데이터 수집
 *  4. page.goBack() → 리스트 복원 → 다음 항목
 *  5. 수집 항목: 리스트 기본정보 + 기일내역 상세 (물건번호, 기일, 종류, 장소, 최저가, 결과)
 *  6. Parquet(GZIP) 저장
 *
 * 실행:
 *  node --experimental-strip-types scripts/scrape-results.ts [옵션]
 * 옵션:
 *  --court      서울중앙지방법원  특정 법원 (기본: 서울중앙지방법원)
 *  --all-courts                  전체 18개 법원 순환
 *  --limit      1                수집할 물건 수 (기본: 1, 전체: 0)
 *  --output     /tmp/out.parquet 출력 경로
 *  --state-file /tmp/state.json  증분 수집용 state 파일
 *  --dry-run                     파일 저장 없이 콘솔 출력만
 */

import { chromium, type Browser, type Page } from 'playwright';
import { writeFileSync, readFileSync, existsSync } from 'fs';
import parquet from '@dsnp/parquetjs';

// ── 법원명 목록 (select option 텍스트와 동일) ──
const COURT_NAMES = [
  '서울중앙지방법원', '서울동부지방법원', '서울남부지방법원',
  '서울북부지방법원', '서울서부지방법원', '의정부지방법원',
  '인천지방법원', '수원지방법원', '춘천지방법원', '대전지방법원',
  '청주지방법원', '대구지방법원', '부산지방법원', '울산지방법원',
  '창원지방법원', '광주지방법원', '전주지방법원', '제주지방법원',
];

// ── 선택된 셀렉트 ID (probe 결과) ──
const COURT_SELECT_ID = 'mf_wfm_mainFrame_sbx_dspslRsltSrchCortOfc';
const SEARCH_BTN_ID   = 'mf_wfm_mainFrame_btn_dspslRsltSrch';
const PAGE_BTN_PREFIX = 'mf_wfm_mainFrame_pgl_gdsDtlSrchPage_page_';
const PAGE_SIZE = 10;

// ── 타입 ──
interface ListItem {
  docid: string;
  boCd: string;
  saNo: string;
  srnSaNo: string;
  maemulSer: string;
  mokmulSer: string;
  jiwonNm: string;
  jpDeptNm: string;
  gamevalAmt: string;
  minmaePrice: string;
  maeAmt: string;           // 낙찰금액
  yuchalCnt: string;
  maeGiil: string;
  maegyuljGiil: string;
  notifyMinmaePrice1: string;
  notifyMinmaePriceRate1: string;
  maePlace: string;
  dspslUsgNm: string;
  printSt: string;
  hjguSido: string;
  hjguSigu: string;
  hjguDong: string;
  srchHjguRdCd: string;
  pjbBuldList: string;
  [key: string]: unknown;
}

interface PageInfo {
  pageNo: number;
  pageSize: number;
  totalCnt: number;
}

interface DateRecord {
  propertyNo: string;   // 물건번호
  appraisedAmt: string; // 감정평가액
  date: string;         // 기일
  type: string;         // 기일종류
  place: string;        // 기일장소
  minPrice: string;     // 최저매각가격
  result: string;       // 기일결과
}

interface ResultRecord {
  docid: string;
  caseNumber: string;
  courtName: string;
  department: string;
  propertyNo: number;
  propertyType: string;
  address: string;
  dongCode: string | null;
  appraisedValue: number;
  minSalePrice: number;
  winBidPrice: number;       // 낙찰금액 (maeAmt)
  minBidRate: number;
  failedBids: number;
  auctionDate: string;
  auctionResultDate: string;
  auctionPlace: string;
  sido: string;
  sigu: string;
  dong: string;
  dateRecords: DateRecord[];
  collectedAt: string;
}

// ── 유틸 ──
function delay(ms: number) {
  return new Promise<void>(r => setTimeout(r, ms));
}

// ── 스크래퍼 ──
class AuctionResultScraper {
  private page!: Page;
  private browser!: Browser;

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
  }

  /** 매각결과 페이지 로드 + 법원 선택 + 검색 → 첫 페이지 결과 반환 */
  async searchCourt(courtName: string): Promise<{ items: ListItem[]; pageInfo: PageInfo }> {
    console.log(`\n[검색] ${courtName}...`);

    await this.page.goto(
      'https://www.courtauction.go.kr/pgj/index.on?w2xPath=/pgj/ui/pgj100/PGJ158M00.xml',
      { waitUntil: 'networkidle', timeout: 40000 }
    );
    await delay(1500);

    await this.page.selectOption(`#${COURT_SELECT_ID}`, courtName);
    await delay(500);

    const result = await this.interceptSearchAndClick(() =>
      this.page.click(`#${SEARCH_BTN_ID}`)
    );
    console.log(`    총 ${result.pageInfo.totalCnt}건, 첫 페이지 ${result.items.length}건 수신`);
    return result;
  }

  /** 다음 페이지 클릭 → API 결과 수신 (페이지 그룹 초과 시 next-group 버튼 클릭) */
  async clickPage(pageNum: number): Promise<{ items: ListItem[]; pageInfo: PageInfo }> {
    const btnId = `${PAGE_BTN_PREFIX}${pageNum}`;

    // 페이지 버튼 존재 여부 확인
    const btnExists = await this.page.locator(`#${btnId}`).count().then(n => n > 0).catch(() => false);
    if (!btnExists) {
      // 다음 페이지 그룹 버튼을 API 인터셉터 안에서 클릭 (그룹 이동이 곧 페이지 데이터 로드)
      const nextGroupResult = await this.interceptSearchAndClick(() =>
        this.page.evaluate(() => {
          const candidates = [
            document.querySelector('.w2pageList_col_nextPage'),
            document.querySelector('.w2pageList_col_next'),
          ];
          for (const el of candidates) {
            if (el) { (el as HTMLElement).click(); return; }
          }
          const pageLinks = Array.from(document.querySelectorAll('a[id*="page_"]'));
          if (pageLinks.length > 0) {
            const lastLink = pageLinks[pageLinks.length - 1];
            const nextEl = lastLink.parentElement?.nextElementSibling;
            if (nextEl) { (nextEl as HTMLElement).click(); }
          }
        }) as Promise<void>
      ).catch(() => null);

      if (nextGroupResult && nextGroupResult.items.length > 0) {
        console.log(`    페이지 ${pageNum}: ${nextGroupResult.items.length}건 수신 (next-group 경유)`);
        return nextGroupResult;
      }

      // next-group으로 데이터를 못 받은 경우 — 버튼 렌더링 대기 후 재시도
      await delay(3000);
    }

    const result = await this.interceptSearchAndClick(() =>
      this.page.click(`#${btnId}`, { timeout: 15000 })
    );
    console.log(`    페이지 ${pageNum}: ${result.items.length}건 수신`);
    return result;
  }

  /** 검색 API 인터셉트 + 트리거 실행 */
  private async interceptSearchAndClick(
    trigger: () => Promise<void>
  ): Promise<{ items: ListItem[]; pageInfo: PageInfo }> {
    let captured: { items: ListItem[]; pageInfo: PageInfo } | null = null;

    const handler = async (res: import('playwright').Response) => {
      if (res.url().includes('selectDspslSchdRsltSrch.on')) {
        try {
          const json = await res.json();
          const data = json.data || {};
          const items = (data.dlt_srchResult || []) as ListItem[];
          const pi = data.dma_pageInfo || {};
          captured = {
            items,
            pageInfo: {
              pageNo: Number(pi.pageNo) || 1,
              pageSize: Number(pi.pageSize) || PAGE_SIZE,
              totalCnt: Number(pi.totalCnt) || 0,
            },
          };
        } catch { /* ignore */ }
      }
    };

    this.page.on('response', handler);
    await trigger();
    await delay(7000);
    this.page.off('response', handler);

    return captured ?? { items: [], pageInfo: { pageNo: 1, pageSize: PAGE_SIZE, totalCnt: 0 } };
  }

  /**
   * 기일내역 직접 API 수집 (브라우저 네비게이션 불필요)
   * POST /pgj/pgj15A/selectCsDtlDxdyDts.on → dlt_dxdyDtsLst
   * 파라미터: cortOfcCd (boCd), csNo (saNo)
   */
  async collectDateRecords(item: ListItem, globalIndex: number): Promise<DateRecord[]> {
    console.log(`  [${globalIndex}] ${item.srnSaNo} 기일내역 API 수집...`);

    const apiUrl = 'https://www.courtauction.go.kr/pgj/pgj15A/selectCsDtlDxdyDts.on';
    const reqBody = {
      dma_srchDxdyDtsLst: {
        cortOfcCd: item.boCd,   // e.g. "B000210"
        csNo: item.saNo,         // e.g. "20230130004722"
      },
    };

    try {
      const res = await this.page.context().request.post(apiUrl, {
        data: JSON.stringify(reqBody),
        headers: {
          'Content-Type': 'application/json;charset=UTF-8',
          'Accept': 'application/json',
          'Referer': 'https://www.courtauction.go.kr/pgj/index.on?w2xPath=/pgj/ui/pgj100/PGJ158M00.xml',
          'submissionid': 'mf_wfm_mainFrame_wfm_dxdyDts_sbm_selectDxdyDtsLst',
          'sc-userid': 'NONUSER',
        },
        timeout: 15000,
      });

      if (!res.ok()) {
        console.log(`    API 오류: status=${res.status()}`);
        return [];
      }

      const json = await res.json();
      const items = (json?.data?.dlt_dxdyDtsLst || []) as Record<string, string>[];

      const dateRecords: DateRecord[] = items.map(r => ({
        propertyNo:   String(r.dspslGdsSeq ?? ''),
        appraisedAmt: String(r.aeeEvlAmt ?? ''),
        date:         String(r.dxdyTime ?? ''),
        type:         String(r.auctnDxdyKndNm ?? ''),
        place:        String(r.dxdyPlcNm ?? ''),
        minPrice:     String(r.tsLwsDspslPrc ?? ''),
        result:       String(r.dxdyRslt ?? ''),
      }));

      console.log(`    기일내역: ${dateRecords.length}건`);
      return dateRecords;
    } catch (e) {
      console.log(`    기일내역 API 실패: ${e}`);
      return [];
    }
  }

  async close(): Promise<void> {
    await this.browser?.close();
  }
}

// ── CLI ──
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

// ── State 파일 ──
interface StateFile {
  version: number;
  lastRunAt: string;
  seenDocIds: Record<string, string>;
}

function loadState(path: string | null): StateFile {
  if (!path) return { version: 1, lastRunAt: '', seenDocIds: {} };
  if (!existsSync(path)) {
    console.log(`[증분] state 없음 → 전체 수집`);
    return { version: 1, lastRunAt: '', seenDocIds: {} };
  }
  try {
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as StateFile;
    console.log(`[증분] state 로드: ${Object.keys(raw.seenDocIds).length}개 기수집 (마지막: ${raw.lastRunAt})`);
    return raw;
  } catch {
    return { version: 1, lastRunAt: '', seenDocIds: {} };
  }
}

function saveState(path: string, state: StateFile): void {
  writeFileSync(path, JSON.stringify(state, null, 2));
  console.log(`[증분] state 저장: ${Object.keys(state.seenDocIds).length}개 → ${path}`);
}

// ── 단일 법원 수집 ──
async function collectCourt(
  scraper: AuctionResultScraper,
  courtName: string,
  limit: number,
  seenDocIds: Record<string, string>,
  dryRun: boolean,
): Promise<{ results: ResultRecord[]; newDocIds: Record<string, string> }> {

  // 1. 첫 페이지 검색
  const { items: page1Items, pageInfo } = await scraper.searchCourt(courtName);
  const totalCnt = pageInfo.totalCnt;
  const totalPages = Math.ceil(totalCnt / PAGE_SIZE);

  console.log(`  [${courtName}] 총 ${totalCnt}건 / ${totalPages}페이지`);

  if (page1Items.length === 0) {
    console.log(`  [${courtName}] 수집된 물건 없음`);
    return { results: [], newDocIds: {} };
  }

  // 2. 전체 페이지 리스트 수집 (페이지별 API 인터셉트)
  const allListItems: ListItem[] = [...page1Items];
  for (let p = 2; p <= totalPages; p++) {
    try {
      const { items } = await scraper.clickPage(p);
      allListItems.push(...items);
    } catch (e) {
      console.log(`  페이지 ${p} 로드 실패: ${e}`);
      break;
    }
  }

  // 3. 증분 필터
  const newItems = allListItems.filter(item => !seenDocIds[item.docid]);
  const skipped = allListItems.length - newItems.length;
  if (skipped > 0) {
    console.log(`  [${courtName}] 전체 ${allListItems.length}건 중 기수집 ${skipped}건 스킵 → 신규 ${newItems.length}건`);
  }
  if (newItems.length === 0) {
    console.log(`  [${courtName}] 신규 없음`);
    return { results: [], newDocIds: {} };
  }

  const targets = limit > 0 ? newItems.slice(0, limit) : newItems;
  console.log(`\n[상세 수집] ${courtName} — ${targets.length}건 시작...`);

  const results: ResultRecord[] = [];
  const newDocIds: Record<string, string> = {};
  const now = new Date().toISOString();

  // 4. 항목별 기일내역 직접 API 수집 (브라우저 네비게이션 불필요)
  if (!dryRun) {
    let globalIdx = 0;
    for (const item of targets) {
      try {
        const dateRecords = await scraper.collectDateRecords(item, ++globalIdx);

        results.push({
          docid: item.docid,
          caseNumber: item.srnSaNo,
          courtName: item.jiwonNm,
          department: item.jpDeptNm,
          propertyNo: Number(item.maemulSer),
          propertyType: item.dspslUsgNm || '',
          address: item.printSt || '',
          dongCode: item.srchHjguRdCd && /^\d{10}$/.test(item.srchHjguRdCd) ? item.srchHjguRdCd : null,
          appraisedValue: Number(item.gamevalAmt),
          minSalePrice: Number(item.notifyMinmaePrice1 || item.minmaePrice),
          winBidPrice: Number(item.maeAmt),
          minBidRate: Number(item.notifyMinmaePriceRate1),
          failedBids: Number(item.yuchalCnt),
          auctionDate: item.maeGiil,
          auctionResultDate: item.maegyuljGiil,
          auctionPlace: item.maePlace || '',
          sido: item.hjguSido || '',
          sigu: item.hjguSigu || '',
          dong: item.hjguDong || '',
          dateRecords,
          collectedAt: now,
        });

        console.log(`    ✅ ${item.srnSaNo} | ${item.dspslUsgNm} | 낙찰가:${Number(item.maeAmt).toLocaleString()}원 | 기일:${dateRecords.length}건`);
        newDocIds[item.docid] = now;
        await delay(500); // API rate limit 방지
      } catch (e) {
        console.log(`    ❌ ${item.srnSaNo} 실패: ${e}`);
        newDocIds[item.docid] = now;
      }
    }
  } else {
    for (const item of targets) {
      console.log(`    [dry] ${item.srnSaNo} | ${item.dspslUsgNm} | 낙찰가:${item.maeAmt}`);
      newDocIds[item.docid] = now;
    }
  }

  return { results, newDocIds };
}

// ── CLI 실행 ──
const args = parseArgs();
const singleCourt = args['court'];
const allCourts = args['all-courts'] === 'true';
const limit = parseInt(args['limit'] ?? '1');
const outputPath = args['output'] || '/tmp/results-single.parquet';
const stateFilePath = args['state-file'] || null;
const dryRun = args['dry-run'] === 'true';

const courtsToScrape: string[] = allCourts
  ? COURT_NAMES
  : [singleCourt || '서울중앙지방법원'];

console.log(`\n=== 매각결과 수집 시작 ===`);
console.log(`법원: ${allCourts ? `전체 ${courtsToScrape.length}개` : courtsToScrape[0]}`);
console.log(`limit: ${limit === 0 ? '전체' : `${limit}건`}, dry-run: ${dryRun}`);
console.log(`state-file: ${stateFilePath || '없음'}`);

const state = loadState(stateFilePath);
const allResults: ResultRecord[] = [];
let totalNewDocIds: Record<string, string> = {};

for (let ci = 0; ci < courtsToScrape.length; ci++) {
  const courtName = courtsToScrape[ci];
  console.log(`\n[${ci + 1}/${courtsToScrape.length}] ${courtName} 수집 시작...`);

  const scraper = new AuctionResultScraper();
  try {
    await scraper.init();
    const { results, newDocIds } = await collectCourt(
      scraper, courtName, limit, state.seenDocIds, dryRun
    );
    allResults.push(...results);
    Object.assign(totalNewDocIds, newDocIds);
  } catch (e) {
    console.log(`  [${courtName}] 수집 오류: ${e}`);
  } finally {
    await scraper.close();
  }

  if (ci < courtsToScrape.length - 1) {
    console.log(`  (다음 법원 전 3초 대기...)`);
    await delay(3000);
  }
}

const newCount = Object.keys(totalNewDocIds).length;
console.log(`\n[완료] 신규 수집: ${newCount}건, 상세 수집: ${allResults.length}건`);

if (stateFilePath && !dryRun && newCount > 0) {
  Object.assign(state.seenDocIds, totalNewDocIds);
  state.lastRunAt = new Date().toISOString();
  saveState(stateFilePath, state);
}

const meta = {
  courts: courtsToScrape,
  collectedAt: new Date().toISOString(),
  total: allResults.length,
  newItems: newCount,
  skippedItems: Object.keys(state.seenDocIds).length - newCount,
  mode: allCourts ? 'all-courts' : 'single-court',
  incremental: stateFilePath !== null,
};

if (!dryRun) {
  const metaPath = outputPath.replace(/\.parquet$/, '.meta.json');
  writeFileSync(metaPath, JSON.stringify(meta, null, 2));

  if (allResults.length > 0) {
    const allKeys = new Set<string>();
    for (const item of allResults) {
      for (const key of Object.keys(item)) allKeys.add(key);
    }

    const schemaFields: Record<string, { type: string; compression: string; optional: boolean }> = {};
    for (const key of allKeys) {
      schemaFields[key] = { type: 'UTF8', compression: 'GZIP', optional: true };
    }

    const schema = new parquet.ParquetSchema(schemaFields);
    const writer = await parquet.ParquetWriter.openFile(schema, outputPath);

    for (const item of allResults) {
      const row: Record<string, string | null> = {};
      for (const key of allKeys) {
        const val = (item as Record<string, unknown>)[key];
        if (val === null || val === undefined) {
          row[key] = null;
        } else if (typeof val === 'object') {
          row[key] = JSON.stringify(val);
        } else {
          row[key] = String(val);
        }
      }
      await writer.appendRow(row);
    }

    await writer.close();
    console.log(`[저장] ${outputPath} (${allResults.length}건, Parquet/GZIP)`);
  } else {
    console.log('[저장] 수집된 데이터 없음 — parquet 파일 생성 생략');
  }
  console.log(`[저장] ${metaPath} (메타)`);
} else {
  console.log('\n[dry-run] 메타:');
  console.log(JSON.stringify(meta, null, 2));
}
