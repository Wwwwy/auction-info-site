/**
 * Phase 0-A: 역사적 낙찰결과 스크래퍼
 * courtauction.go.kr 에서 24 개월 치 낙찰데이터 수집
 *
 * 실행: bun run scripts/seed-historical.ts [옵션]
 * 옵션:
 *   --from YYYY-MM-DD     수집 시작일 (기본: 24 개월 전)
 *   --to   YYYY-MM-DD     수집 종료일 (기본: 어제)
 *   --courts 서울중앙,인천  특정 법원만 (기본: 전체 23 개)
 *   --dry-run             DB 저장 없이 파싱 결과만 출력
 *   --resume              체크포인트에서 재개
 */

import { chromium, type Page } from 'playwright';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';

// ── 상수 설정 ──
const DELAY_MS = 4000;        // 요청 간격 (rate limit 방지)
const RETRY_MAX = 3;
const PAGE_SIZE = 100;        // 한 번에 가져올 최대 건수
const CHECKPOINT_FILE = '/tmp/seed-checkpoint.json';

// ── 법원 코드 목록 (Task 0-A-2 에서 확보) ──
// 실제 스크래핑 시 /pgj/pgj002/selectCortOfcLst.on 에서 동적 수집 권장
const COURT_CODES: Record<string, string> = {
  '서울중앙': '0101',
  '서울동부': '0102',
  '서울남부': '0103',
  '서울북부': '0104',
  '서울서부': '0105',
  '인천': '0201',
  '수원': '0301',
  '성남': '0302',
  '의정부': '0303',
  '춘천': '0401',
  '대전': '0501',
  '청주': '0502',
  '대구': '0601',
  '부산': '0701',
  '울산': '0702',
  '창원': '0703',
  '광주': '0801',
  '전주': '0802',
  '제주': '0901',
  '부천': '1001',
  '평택': '1002',
  '안양': '1003',
  '안산': '1004',
};

// ── 타입 정의 ──
interface RawAuctionResult {
  srnSaNo: string;        // 사건번호
  gamevalAmt: string;     // 감정가
  maeAmt?: string;        // 낙찰가 (유찰 시 0 또는 없음)
  maeGiil?: string;       // 낙찰일 (YYYYMMDD)
  srchHjguRdCd?: string;  // 법정동코드 (10 자리)
  dspslUsgNm: string;     // 물건종류
  pjbBuldList?: string;   // 면적정보 ("철근콘크리트구조 23.63㎡")
  jiwonNm: string;        // 법원명
  yuchalCnt?: string;     // 유찰횟수
  printSt?: string;       // 인쇄용 주소
}

interface ParsedResult {
  caseNumber: string;
  courtName: string;
  dongCode: string | null;
  propertyType: string;
  areaSqm: number | null;
  appraised: number;
  winningBid: number | null;
  resultDate: string | null;
  rawAddress: string | null;
  failedBids: number;
}

interface Checkpoint {
  lastCourtCd: string;
  lastDate: string;
  totalInserted: number;
  processedRanges: string[];
}

// ── 유틸리티 함수 ──

/** 면적 파싱 (Task 0-B-3) */
function parseAreaFromBuildingInfo(pjbBuldList: string | null | undefined): number | null {
  if (!pjbBuldList) return null;
  const match = pjbBuldList.match(/(\d+\.?\d*)㎡/);
  return match ? parseFloat(match[1]) : null;
}

/** 낙찰결과 파싱 (Task 0-B-1) */
function parseAuctionResult(raw: RawAuctionResult): ParsedResult | null {
  const areaSqm = parseAreaFromBuildingInfo(raw.pjbBuldList);
  const winningBid = raw.maeAmt && Number(raw.maeAmt) > 0
    ? Number(raw.maeAmt)
    : null;

  return {
    caseNumber: raw.srnSaNo,
    courtName: raw.jiwonNm,
    dongCode: raw.srchHjguRdCd && /^\d{10}$/.test(raw.srchHjguRdCd)
      ? raw.srchHjguRdCd
      : null,
    propertyType: raw.dspslUsgNm,
    areaSqm,
    appraised: Number(raw.gamevalAmt),
    winningBid,
    resultDate: raw.maeGiil || null,
    rawAddress: raw.printSt || null,
    failedBids: Number(raw.yuchalCnt || 0),
  };
}

/** 날짜 범위 생성 (월 단위 분할) */
function generateDateRanges(from: Date, to: Date): { from: string; to: string }[] {
  const ranges: { from: string; to: string }[] = [];
  const current = new Date(from);
  current.setDate(1);

  while (current <= to) {
    const year = current.getFullYear();
    const month = String(current.getMonth() + 1).padStart(2, '0');
    const lastDay = new Date(year, current.getMonth() + 1, 0).getDate();

    ranges.push({
      from: `${year}${month}01`,
      to: `${year}${month}${String(lastDay).padStart(2, '0')}`,
    });

    current.setMonth(current.getMonth() + 1);
  }

  return ranges;
}

/** 체크포인트 로드 */
function loadCheckpoint(): Checkpoint | null {
  if (!existsSync(CHECKPOINT_FILE)) return null;
  try {
    return JSON.parse(readFileSync(CHECKPOINT_FILE, 'utf-8'));
  } catch {
    return null;
  }
}

/** 체크포인트 저장 */
function saveCheckpoint(checkpoint: Checkpoint): void {
  writeFileSync(CHECKPOINT_FILE, JSON.stringify(checkpoint, null, 2));
}

/** 세션 만료 감지及安全 evaluate */
async function safeEvaluate<T>(page: Page, fn: () => Promise<T>, retries = 3): Promise<T> {
  for (let i = 0; i < retries; i++) {
    try {
      const result = await page.evaluate(fn);
      // 세션 만료 체크 (리다이렉트 또는 명시적 만료 신호)
      if (result && typeof result === 'object' &&
          ('status' in result && (result as any).status === 'SESSION_EXPIRED')) {
        await page.reload({ waitUntil: 'networkidle' });
        await page.waitForTimeout(3000);
        continue;
      }
      return result as T;
    } catch (e) {
      if (i === retries - 1) throw e;
      await page.waitForTimeout(5000 * (i + 1));
    }
  }
  throw new Error('safeEvaluate max retries exceeded');
}

// ── 메인 스크래퍼 클래스 ──

class AuctionScraper {
  private page: Page | null = null;
  private collectedData: ParsedResult[] = [];
  private stats = {
    total: 0,
    parsed: 0,
    withDongCode: 0,
    withWinningBid: 0,
    errors: 0,
  };

  async initialize(): Promise<void> {
    console.log('[1] 브라우저 초기화 (스텔스 모드)...');
    const browser = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-blink-features=AutomationControlled',
        '--disable-infobars',
        '--window-size=1920,1080',
        '--lang=ko-KR',
      ],
    });

    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      viewport: { width: 1920, height: 1080 },
      locale: 'ko-KR',
      timezoneId: 'Asia/Seoul',
      extraHTTPHeaders: {
        'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7',
        'Accept-Encoding': 'gzip, deflate, br',
        'Sec-Ch-Ua': '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
        'Sec-Ch-Ua-Mobile': '?0',
        'Sec-Ch-Ua-Platform': '"Windows"',
      },
    });

    // navigator.webdriver 제거
    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
      Object.defineProperty(navigator, 'languages', { get: () => ['ko-KR', 'ko', 'en-US', 'en'] });
      (window as any).chrome = { runtime: {} };
    });

    this.page = await context.newPage();

    // API 요청에 Referer/Sec-Fetch-* 헤더 자동 주입
    await this.page.route('**/*.on', async (route, request) => {
      const headers = {
        ...request.headers(),
        'Referer': 'https://www.courtauction.go.kr/',
        'Origin': 'https://www.courtauction.go.kr',
        'Sec-Fetch-Site': 'same-origin',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Dest': 'empty',
        'X-Requested-With': 'XMLHttpRequest',
      };
      await route.continue({ headers });
    });

    console.log('[2] courtauction.go.kr 초기 로딩...');
    await this.page.goto('https://www.courtauction.go.kr/pgj/index.on', {
      waitUntil: 'networkidle',
      timeout: 35000,
    });
    await this.page.waitForTimeout(2000 + Math.random() * 1000);
    // 실제 사용자 동작 시뮬레이션
    await this.page.evaluate(() => window.scrollTo(0, 200));
    await this.page.waitForTimeout(500);
    await this.page.evaluate(() => window.scrollTo(0, 0));
    await this.page.waitForTimeout(1000);
  }

  /**
   * Task 0-A-1: 낙찰결과 엔드포인트 탐색 및 데이터 수집
   * 현재 프로토타입은 searchControllerMain.on 만 검증됨
   * 낙찰결제는 별도 엔드포인트 필요 (예: pgj100/PGJ151F00.xml)
   */
  async fetchResultsPage(
    courtCd: string,
    startDate: string,
    endDate: string,
    pageIndex: number = 1
  ): Promise<RawAuctionResult[]> {
    if (!this.page) throw new Error('Browser not initialized');

    console.log(`    [fetch] 법원=${courtCd}, 기간=${startDate}~${endDate}, 페이지=${pageIndex}`);

    const body = {
      dma_pageInfo: {
        pageNo: pageIndex,
        pageSize: PAGE_SIZE,
        bfPageNo: '',
        startRowNo: '',
        totalCnt: '',
        totalYn: 'Y',
        groupTotalCount: '',
      },
      dma_srchGdsDtlSrchInfo: {
        statNum: '1',
        pgmId: 'PGJ158M01',
        cortStDvs: '0',
        cortOfcCd: courtCd,
        jdbnCd: '',
        csNo: '',
        rprsAdongSdCd: '', rprsAdongSggCd: '', rprsAdongEmdCd: '',
        rdnmSdCd: '', rdnmSggCd: '', rdnmNo: '',
        auctnGdsStatCd: '',
        lclDspslGdsLstUsgCd: '', mclDspslGdsLstUsgCd: '', sclDspslGdsLstUsgCd: '',
        dspslAmtMin: '', dspslAmtMax: '',
        aeeEvlAmtMin: '', aeeEvlAmtMax: '',
        flbdNcntMin: '', flbdNcntMax: '',
        lafjOrderBy: '',
        srchStartMaeGiil: startDate,
        srchEndMaeGiil: endDate,
      },
    };

    try {
      const result = await this.page.evaluate(async (bodyArg) => {
        return new Promise<string>((resolve, reject) => {
          fetch('/pgj/pgjsearch/selectDspslSchdRsltSrch.on', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Accept': 'application/json, text/plain, */*' },
            body: JSON.stringify(bodyArg),
          })
            .then(res => res.text())
            .then(resolve)
            .catch(reject);
        });
      }, body);

      // JSON 파싱
      console.log(`    raw(200): ${(result as string).slice(0, 200)}`);
      const parsed = JSON.parse(result as string);
      const items = parsed.data?.dlt_srchResult || [];

      console.log(`    → ${items.length}건 수신 (ipcheck:${parsed.data?.ipcheck})`);
      return items as RawAuctionResult[];

    } catch (error) {
      console.error(`    ✗ 에러: ${error}`);
      this.stats.errors++;
      return [];
    }
  }

  async scrapeCourtForPeriod(
    courtName: string,
    courtCd: string,
    dateRanges: { from: string; to: string }[],
    dryRun: boolean = false
  ): Promise<ParsedResult[]> {
    const results: ParsedResult[] = [];

    for (const range of dateRanges) {
      let pageIndex = 1;
      let hasMore = true;

      while (hasMore) {
        const rawResults = await this.fetchResultsPage(
          courtCd,
          range.from,
          range.to,
          pageIndex
        );

        if (rawResults.length === 0) {
          hasMore = false;
          continue;
        }

        // 파싱
        for (const raw of rawResults) {
          const parsed = parseAuctionResult(raw);
          if (parsed) {
            results.push(parsed);
            this.stats.parsed++;
            if (parsed.dongCode) this.stats.withDongCode++;
            if (parsed.winningBid) this.stats.withWinningBid++;
          }
        }

        this.stats.total += rawResults.length;

        // 다음 페이지 여부 (100 건 미만이면 마지막 페이지)
        hasMore = rawResults.length >= PAGE_SIZE;
        if (hasMore) {
          pageIndex++;
          await new Promise(r => setTimeout(r, DELAY_MS));
        }
      }

      console.log(`  [${courtName} / ${range.from.slice(0, 6)}] ${results.length}건 수집 (누적: ${this.stats.total})`);
    }

    return results;
  }

  async run(
    options: {
      from?: string;
      to?: string;
      courts?: string[];
      dryRun?: boolean;
      resume?: boolean;
      output?: string;
    } = {}
  ): Promise<void> {
    const startDate = options.from
      ? new Date(options.from)
      : new Date(new Date().setMonth(new Date().getMonth() - 24));

    const endDate = options.to
      ? new Date(options.to)
      : new Date();
    endDate.setDate(endDate.getDate() - 1);  // 어제까지

    const targetCourts = options.courts?.length
      ? options.courts
      : Object.keys(COURT_CODES);

    const dateRanges = generateDateRanges(startDate, endDate);

    console.log('\n═══════════════════════════════════════');
    console.log(' 경매 낙찰결과 스크래퍼 시작');
    console.log('═══════════════════════════════════════');
    console.log(`  기간: ${startDate.toISOString().slice(0, 10)} ~ ${endDate.toISOString().slice(0, 10)}`);
    console.log(`  법원: ${targetCourts.length}개 (${targetCourts.slice(0, 5).join(', ')}${targetCourts.length > 5 ? '...' : ''})`);
    console.log(`  개월: ${dateRanges.length}개월`);
    console.log(`  모드: ${options.dryRun ? 'DRY-RUN (DB 저장 안함)' : 'LIVE'}`);
    console.log('═══════════════════════════════════════\n');

    await this.initialize();

    try {
      for (const courtName of targetCourts) {
        const courtCd = COURT_CODES[courtName];
        if (!courtCd) {
          console.warn(`  ⚠ 법원코드 없음: ${courtName}`);
          continue;
        }

        const results = await this.scrapeCourtForPeriod(
          courtName,
          courtCd,
          dateRanges,
          options.dryRun
        );

        if (!options.dryRun) {
          this.collectedData.push(...results);
          console.log(`    → 누적 수집: ${this.collectedData.length}건`);
        }

        // 체크포인트 저장
        saveCheckpoint({
          lastCourtCd: courtCd,
          lastDate: dateRanges[dateRanges.length - 1]?.from,
          totalInserted: this.stats.total,
          processedRanges: dateRanges.map(r => `${courtCd}-${r.from}`),
        });

        // Rate limit 방지
        await new Promise(r => setTimeout(r, DELAY_MS));
      }

      console.log('\n═══════════════════════════════════════');
      console.log(' 스크래핑 완료');
      console.log('═══════════════════════════════════════');
      console.log(`  총 수신:     ${this.stats.total}건`);
      console.log(`  파싱 성공:   ${this.stats.parsed}건`);
      console.log(`  법정동코드:  ${this.stats.withDongCode}건 (${this.stats.parsed ? Math.round(100 * this.stats.withDongCode / this.stats.parsed) : 0}%)`);
      console.log(`  낙찰완료:    ${this.stats.withWinningBid}건`);
      console.log(`  에러:       ${this.stats.errors}건`);
      console.log('═══════════════════════════════════════\n');

      // JSON 파일 저장
      const outputPath = options.output || '/tmp/auction-results.json';
      writeFileSync(outputPath, JSON.stringify({
        meta: {
          collectedAt: new Date().toISOString(),
          from: options.from || 'auto',
          to: options.to || 'auto',
          courts: options.courts || 'all',
          total: this.stats.total,
          parsed: this.stats.parsed,
        },
        results: this.collectedData,
      }, null, 2));
      console.log(`[저장] ${outputPath} (${this.collectedData.length}건)`);

    } finally {
      // 브라우저 정리
      console.log('[완료] 브라우저 종료...');
    }
  }
}

// ── CLI 파싱 및 실행 ──

function parseArgs(): Record<string, string | string[]> {
  const args = process.argv.slice(2);
  const result: Record<string, string | string[]> = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const value = args[i + 1];
      if (value && !value.startsWith('--')) {
        if (key === 'courts') {
          result[key] = value.split(',');
        } else {
          result[key] = value;
        }
        i++;
      } else {
        result[key] = true;
      }
    }
  }

  return result;
}

const args = parseArgs();

const scraper = new AuctionScraper();
scraper.run({
  from: args.from as string | undefined,
  to: args.to as string | undefined,
  courts: Array.isArray(args.courts) ? args.courts : undefined,
  dryRun: args.dryRun === true,
  output: args.output as string | undefined,
  resume: args.resume === true,
}).catch(console.error);
